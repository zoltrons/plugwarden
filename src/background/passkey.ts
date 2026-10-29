// Passkeys for websites (opt-in). Registered content scripts forward navigator.credentials calls over a
// port; the user approves each one in a Plugwarden window (which first asks to unlock if needed); the
// crypto worker signs. Closing the window hands the call back to the browser.
import {
  type PasskeyCall,
  type PasskeyCandidate,
  type PasskeyPrompt,
  type PasskeyResult,
  parsePasskeyCall,
} from "../shared/messages.ts";
import { UserError } from "./account.ts";
import { coreCall } from "./core.ts";
import { getLocal, getSettings, setLocal } from "./store.ts";
import { list, requireUnlocked, save } from "./vault.ts";

const SCRIPT_IDS = ["pw-passkey-page", "pw-passkey-relay"];

interface Pending {
  call: PasskeyCall;
  origin: string;
  rpId: string;
  tabId: number;
  windowId?: number;
  done(r: PasskeyResult): void;
}

// In memory on purpose: if the service worker dies, the relay's port closes and the page falls back.
const pending = new Map<string, Pending>();

/** Registers (or removes) the page shim + relay on every site the user granted access to. */
export async function setPasskeys(enabled: boolean): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => undefined);
  if (enabled) {
    // WebAuthn needs a secure context: https, or localhost during development.
    const matches = ((await chrome.permissions.getAll()).origins ?? []).filter((o) => o.startsWith("https://") || /^http:\/\/localhost[:/]/.test(o));
    if (!matches.length) throw new UserError("permission", "Access to websites was not granted");
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_IDS[0]!, js: ["passkey-page.js"], matches, runAt: "document_start", world: "MAIN" },
      { id: SCRIPT_IDS[1]!, js: ["passkey-relay.js"], matches, runAt: "document_start" },
    ]);
  }
  await setLocal("settings", { ...(await getSettings()), passkeys: enabled });
}

const error = (name: string, message: string): PasskeyResult => ({ error: { name, message } });

export function onPasskeyPort(port: chrome.runtime.Port): void {
  const origin = port.sender?.origin;
  // Top frames of web pages only; the origin comes from the browser, never from the page.
  if (port.sender?.id !== chrome.runtime.id || !port.sender.tab || port.sender.frameId !== 0 || !origin?.startsWith("http")) {
    port.disconnect();
    return;
  }
  let id: string | undefined;
  port.onDisconnect.addListener(() => {
    const p = id ? pending.get(id) : undefined;
    if (p?.windowId !== undefined) void chrome.windows.remove(p.windowId).catch(() => undefined);
    if (id) pending.delete(id);
  });
  port.onMessage.addListener(async (msg: unknown) => {
    if ((msg as { ping?: unknown } | null)?.ping || id) return; // keep-alive pings; one call per port
    let call: PasskeyCall;
    try {
      call = parsePasskeyCall(msg);
    } catch {
      port.disconnect();
      return;
    }
    if (!(await getSettings()).passkeys || !(await getLocal("account"))) return port.postMessage({ fallback: true });
    const tabId = port.sender!.tab!.id!;
    // One approval window per tab, so a page cannot pile up windows by calling in a loop.
    if ([...pending.values()].some((p) => p.tabId === tabId)) return port.postMessage(error("NotAllowedError", "Another passkey request is pending"));
    id = crypto.randomUUID();
    const reqId = id;
    pending.set(reqId, {
      call,
      origin,
      rpId: (call.options.rpId || new URL(origin).hostname).toLowerCase(),
      tabId,
      done: (r) => {
        pending.delete(reqId);
        port.postMessage(r);
      },
    });
    const w = await chrome.windows.create({ url: `popup.html?passkey=${reqId}`, type: "popup", width: 400, height: 600, focused: true });
    const p = pending.get(reqId);
    if (p) p.windowId = w?.id;
  });
}

/** The approval window was closed without a decision: let the browser handle the call. */
export function onWindowRemoved(windowId: number): void {
  for (const p of pending.values()) if (p.windowId === windowId) p.done({ fallback: true });
}

function get(id: string): Pending {
  const p = pending.get(id);
  if (!p) throw new UserError("sessionExpired", "This passkey request is no longer active");
  return p;
}

async function candidates(p: Pending, ids: string[]): Promise<PasskeyCandidate[]> {
  await list(); // vault loaded into the worker
  return coreCall<PasskeyCandidate[]>({ op: "passkeyCandidates", rpId: p.rpId, origin: p.origin, ids });
}

export async function passkeyPrompt(id: string): Promise<PasskeyPrompt> {
  await requireUnlocked();
  const p = get(id);
  const base = { origin: p.origin, rpId: p.rpId };
  if (p.call.kind === "get") return { kind: "get", ...base, candidates: await candidates(p, p.call.options.allow) };
  return { kind: "create", ...base, rpName: p.call.options.rpName, userName: p.call.options.user.name, candidates: [] };
}

export async function passkeyDecision(id: string, action: "use" | "fallback", itemId?: string, credentialId?: string): Promise<null> {
  const p = get(id);
  if (action === "fallback") return (p.done({ fallback: true }), null);
  await requireUnlocked();
  try {
    if (p.call.kind === "get") {
      const c = (await candidates(p, p.call.options.allow)).find((x) => x.itemId === itemId && x.credentialId === credentialId);
      if (!c) throw new UserError("invalid", "Choose one of the passkeys for this site");
      const credential = await coreCall<Record<string, unknown>>({ op: "passkeyAssert", itemId: c.itemId, credentialId: c.credentialId, rpId: p.rpId, origin: p.origin, challenge: p.call.options.challenge });
      p.done({ credential });
    } else {
      const o = p.call.options;
      if (o.exclude.length && (await candidates(p, o.exclude)).length)
        return (p.done(error("InvalidStateError", "A passkey for this account already exists in Plugwarden")), null);
      const r = await coreCall<{ fido2Credential: Record<string, unknown>; response: Record<string, unknown> }>({
        op: "passkeyCreate",
        input: { origin: p.origin, rpId: p.rpId, rpName: o.rpName, challenge: o.challenge, user: o.user, discoverable: o.discoverable },
      });
      // shortcut: always a new Login item; choosing an existing item to attach the passkey to is not offered.
      await save({ type: 1, name: o.rpName || p.rpId, login: { username: o.user.name, uris: [{ uri: p.origin, match: null }], fido2Credentials: [r.fido2Credential] } });
      p.done({ credential: r.response });
    }
  } catch (e) {
    if (e instanceof UserError && e.code === "invalid") throw e;
    p.done(error("NotAllowedError", e instanceof Error ? e.message : String(e)));
  }
  return null;
}
