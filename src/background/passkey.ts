// Passkeys for websites, always on (like the official clients). The MAIN-world shim
// (passkey-page.js) + isolated relay (passkey-relay.js) are registered on every secure origin, so a
// WebAuthn call that a stored passkey can answer is served by Plugwarden, and everything else is
// handed straight back to the browser. Conditional mediation (passkey autofill) additionally shows
// "Sign in with a passkey" in the inline menu while the website is waiting for an assertion.
// Crypto runs in the worker (offscreen/fido2.ts); credentials are stored as Bitwarden's
// `login.fido2Credentials[]`, so they round-trip through the SDK model and sync with the official apps.
import {
  type PasskeyCall,
  type PasskeyCandidate,
  type PasskeyPrompt,
  type PasskeyResult,
  parsePasskeyCall,
} from "../shared/messages.ts";
import { UserError } from "./account.ts";
import { coreAlive, coreCall } from "./core.ts";
import { getLocal, getSession } from "./store.ts";
import { list, requireUnlocked, save } from "./vault.ts";

const SCRIPT_IDS = ["pw-passkey-page", "pw-passkey-relay"];
/**
 * A conditional (passkey-autofill) request is kept open by the page pinging the port, which also keeps
 * the service worker awake. Bound how long one can live.
 */
const CONDITIONAL_TTL_MS = 5 * 60_000;
/** WebAuthn needs a secure context: https, or localhost during development. */
const MATCHES = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];

interface Pending {
  id: string;
  call: PasskeyCall;
  origin: string;
  rpId: string;
  tabId: number;
  frameId: number;
  /** Conditional mediation: no approval window until the user picks the inline-menu entry. */
  conditional: boolean;
  windowId?: number;
  done(r: PasskeyResult): void;
}

// In memory on purpose: if the service worker dies, the relay's port closes and the page falls back.
const pending = new Map<string, Pending>();

/** Idempotent: registered content scripts persist across sessions, so this usually does nothing. */
export async function ensurePasskeyScripts(): Promise<void> {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS }).catch(() => []);
  if (scripts.length === SCRIPT_IDS.length) return;
  await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => undefined);
  await chrome.scripting.registerContentScripts([
    { id: SCRIPT_IDS[0]!, js: ["passkey-page.js"], matches: MATCHES, runAt: "document_start", world: "MAIN", persistAcrossSessions: true },
    { id: SCRIPT_IDS[1]!, js: ["passkey-relay.js"], matches: MATCHES, runAt: "document_start", persistAcrossSessions: true },
  ]);
}

const error = (name: string, message: string): PasskeyResult => ({ error: { name, message } });

const unlocked = async () => (await getSession()).unlocked && (await coreAlive());

/** Lets the content script refresh its inline menu (the passkey entry may have appeared or gone). */
const refreshMenu = (tabId: number, frameId: number) =>
  chrome.tabs.sendMessage(tabId, { type: "passkeyAvailable" }, { frameId }).catch(() => undefined);

const conditionalFor = (tabId: number, frameId?: number) =>
  [...pending.values()].find((p) => p.conditional && p.tabId === tabId && (frameId === undefined || p.frameId === frameId));

export function onPasskeyPort(port: chrome.runtime.Port): void {
  const sender = port.sender;
  const origin = sender?.origin;
  // Top frames of web pages only; the origin comes from the browser, never from the page.
  if (sender?.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0 || !origin?.startsWith("http")) {
    port.disconnect();
    return;
  }
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  let id: string | undefined;
  let closed = false;

  port.onDisconnect.addListener(() => {
    closed = true;
    const p = id ? pending.get(id) : undefined;
    if (p?.windowId !== undefined) void chrome.windows.remove(p.windowId).catch(() => undefined);
    if (p) p.done({ fallback: true });
  });

  port.onMessage.addListener((msg: unknown) => {
    const m = msg as { ping?: unknown; abort?: unknown } | null;
    if (m?.ping) return; // keep-alive while the user decides
    if (m?.abort) {
      // The page aborted the call (AbortSignal) or the browser answered it first.
      const p = id ? pending.get(id) : undefined;
      if (p) {
        if (p.windowId !== undefined) void chrome.windows.remove(p.windowId).catch(() => undefined);
        p.done({ fallback: true });
      }
      return;
    }
    if (id) return; // one call per port
    let call: PasskeyCall;
    try {
      call = parsePasskeyCall(m);
    } catch {
      port.disconnect();
      return;
    }
    void handle(call, origin);
  });

  async function handle(call: PasskeyCall, origin: string): Promise<void> {
    if (!(await getLocal("account"))) return port.postMessage({ fallback: true });
    // One approval window per tab, so a page cannot pile up windows by calling in a loop.
    if ([...pending.values()].some((p) => p.tabId === tabId && p.windowId !== undefined))
      return port.postMessage(error("NotAllowedError", "Another passkey request is pending"));
    const conditional = call.kind === "get" && call.conditional;
    const reqId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p: Pending = {
      id: reqId,
      call,
      origin,
      rpId: (call.options.rpId || new URL(origin).hostname).toLowerCase(),
      tabId,
      frameId,
      conditional,
      done: (r) => {
        clearTimeout(timer);
        pending.delete(reqId);
        if (conditional) void refreshMenu(tabId, frameId);
        if (closed) return;
        try {
          port.postMessage(r);
        } catch {
          // The page went away between the decision and the reply.
        }
      },
    };
    if (conditional) {
      // A newer conditional call replaces the one still waiting (the page re-requested).
      const previous = conditionalFor(tabId, frameId);
      if (previous) previous.done(error("AbortError", "This passkey request was replaced by a newer one"));
    }
    pending.set(reqId, p);
    id = reqId;
    if (conditional) timer = setTimeout(() => void p.done({ fallback: true }), CONDITIONAL_TTL_MS);
    if (call.kind === "get") {
      if (await unlocked()) {
        // Nothing in the vault can answer this call: stay out of the way, no window.
        const found = await candidates(p, call.options.allow).catch(() => []);
        if (!found.length) return p.done({ fallback: true });
      } else if (conditional) {
        // Passkey autofill runs on page load: never nag for the master password. The browser's own
        // conditional UI keeps working, and the inline menu entry appears after unlocking.
        return p.done({ fallback: true });
      }
    }
    if (!pending.has(reqId)) return; // the page aborted while we were deciding
    if (conditional) {
      void refreshMenu(tabId, frameId); // the inline menu offers the passkey from now on
      return;
    }
    try {
      await openWindow(p);
    } catch {
      p.done({ fallback: true });
    }
  }
}

async function openWindow(p: Pending): Promise<void> {
  if (p.windowId !== undefined) {
    await chrome.windows.update(p.windowId, { focused: true }).catch(() => undefined);
    return;
  }
  const w = await chrome.windows.create({ url: `popup.html?passkey=${p.id}`, type: "popup", width: 400, height: 600, focused: true });
  p.windowId = w?.id;
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

/** Inline menu: is there a stored passkey for the conditional request waiting in this frame? */
export async function conditionalReady(tabId: number, frameId: number): Promise<boolean> {
  const p = conditionalFor(tabId, frameId);
  if (!p || p.call.kind !== "get") return false;
  try {
    return (await candidates(p, p.call.options.allow)).length > 0;
  } catch {
    return false;
  }
}

/** Inline menu "Sign in with a passkey": ask the user to pick one in the approval window. */
export async function openConditional(tabId: number, frameId: number): Promise<void> {
  const p = conditionalFor(tabId, frameId);
  if (!p) throw new UserError("sessionExpired", "This passkey request is no longer active");
  await openWindow(p);
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
