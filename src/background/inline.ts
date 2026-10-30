// Inline menu and save/update bar. The content script reports focused fields and submitted logins;
// menu.html / bar.html (extension pages framed into the site) ask for data and act. Matching always
// uses the URL of the frame the field is in, as reported by the browser (sender.url).
import { type FillResult, fillInPage } from "../autofill/page.ts";
import type { BarInfo, FieldKind, FrameRequest, MenuData, MenuItem, PageRequest, VaultItem } from "../shared/messages.ts";
import { coreCall } from "./core.ts";
import { touchAutoLock } from "./lock.ts";
import { pageLoadFill } from "./autofill.ts";
import { conditionalReady, openConditional } from "./passkey.ts";
import { getLocal, getSettings, getTabState, setLocal, setTabState } from "./store.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { copyToClipboard, ensureLoaded, isUnlocked, list, markUsed, save } from "./vault.ts";

export interface InlineContext {
  frameId: number;
  url: string;
  kind: FieldKind;
  /** The opening document's secret, echoed by the menu frame (see PageRequest.inlineFocus). */
  nonce: string;
}

export interface PendingSave {
  kind: "add" | "update";
  url: string;
  username: string;
  password: string;
  itemId?: string;
  /** Secret handed to the bar frame, so a bar the page frames itself cannot save (see showBar). */
  token: string;
  /** epoch ms */
  expiresAt: number;
}

const SAVE_TTL_MS = 5 * 60_000;

const httpUrl = (u: string | undefined) => (u && /^https?:/.test(u) ? u : undefined);

async function items(kind: FieldKind, url: string): Promise<MenuItem[]> {
  const pick = ({ id, type, name, sub }: VaultItem) => ({ id, type, name, sub });
  if (kind === "login") {
    await ensureLoaded();
    const { defaultUriMatch } = await getSettings();
    return (await coreCall<VaultItem[]>({ op: "matchUri", url, defaultMatch: defaultUriMatch })).map(pick);
  }
  const settings = await getSettings();
  if (kind === "card" && !settings.inlineMenuCards) return [];
  if (kind === "identity" && !settings.inlineMenuIdentities) return [];
  const type = kind === "card" ? 3 : 4;
  return (await list()).items.filter((i) => i.type === type && !i.failed).map(pick);
}


/**
 * Page-originated work is cheap for a page to request and expensive to run (vault scan, PSL). One focus
 * at a time per tab. (Submitted logins are coalesced per tab before the queue, in index.ts.)
 */
const inFlight = new Set<string>();

const oncePerTab = async <T>(key: string, tabId: number, fn: () => Promise<T>, busy: T): Promise<T> => {
  const k = `${key}:${tabId}`;
  if (inFlight.has(k)) return busy;
  inFlight.add(k);
  try {
    return await fn();
  } finally {
    inFlight.delete(k);
  }
};

/** Content script: `rows` tells it how tall the menu is, 0 = do not show one. */
export async function handlePage(req: PageRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (req.type === "pageLoad") return pageLoadFill(sender);
  const url = httpUrl(sender.url);
  const tabId = sender.tab?.id;
  if (!url || tabId === undefined || sender.frameId === undefined) return { rows: 0 };
  if (req.type === "inlineFocus")
    return oncePerTab("focus", tabId, () => onFocus(req.kind, req.nonce, url, tabId!, sender.frameId!), { rows: 0 });
  await loginSubmitted(tabId, url, req.username, req.password);
  return null;
}

async function onFocus(kind: FieldKind, nonce: string, url: string, tabId: number, frameId: number): Promise<{ rows: number }> {
  if (!(await getSettings()).inlineMenu || !(await getLocal("account"))) return { rows: 0 };
  await setTabState("inline", tabId, { frameId, url, kind, nonce });
  if (!(await isUnlocked())) return { rows: 1 }; // "Unlock to fill"
  const logins = (await items(kind, url)).length;
  // A website waiting on a conditional passkey request gets one extra row for it.
  const passkey = kind === "login" && (await conditionalReady(tabId, frameId));
  return { rows: logins + (passkey ? 1 : 0) };
}

async function loginSubmitted(tabId: number, url: string, username: string, password: string) {
  const settings = await getSettings();
  const host = new URL(url).host;
  if (!settings.savePrompt || settings.neverSave.includes(host) || !(await isUnlocked())) return;
  await ensureLoaded();
  const matches = await coreCall<VaultItem[]>({ op: "matchUri", url, defaultMatch: settings.defaultUriMatch });
  const same = matches.find((m) => m.sub === username && !m.readOnly);
  const expiresAt = Date.now() + SAVE_TTL_MS;
  let pending: PendingSave | undefined;
  if (!same) pending = { kind: "add", url, username, password, token: "", expiresAt };
  // A flagged item is never compared or overwritten from inside a page: edit it in the popup.
  else if (repromptPending(same)) return;
  else if ((await coreCall<{ password: string }>({ op: "fillData", id: same.id })).password !== password)
    pending = { kind: "update", url, username, password, itemId: same.id, token: "", expiresAt };
  if (!pending) return;
  await setTabState("save", tabId, pending);
  await showBar(tabId);
}

/** A pending save, dropping it once its TTL passed so a typed password never outlives it. */
async function pendingSave(tabId: number): Promise<PendingSave | undefined> {
  const p = await getTabState("save", tabId);
  if (!p) return undefined;
  if (p.expiresAt <= Date.now()) {
    await setTabState("save", tabId, undefined);
    return undefined;
  }
  return p;
}

/** Also called when the tab finishes loading: logins are usually submitted right before a navigation. */
export async function showBar(tabId: number): Promise<void> {
  const p = await pendingSave(tabId);
  if (!p) return;
  // The pending login was typed on `p.url`: never offer it on a page of another site (the tab may have
  // navigated away). It is kept until it expires, so coming back to the site still prompts.
  if (!(await onSameSite(tabId, p.url))) return;
  // A fresh token per show, carried by the bar frame it opens and required back from it: a copy of
  // bar.html framed by the page has no token and cannot save.
  const token = crypto.randomUUID();
  await setTabState("save", tabId, { ...p, token });
  await chrome.tabs.sendMessage(tabId, { type: "barShow", token }, { frameId: 0 }).catch(() => undefined);
}

async function onSameSite(tabId: number, url: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab.url && new URL(tab.url).origin === new URL(url).origin;
  } catch {
    return false; // no such tab, or a page we cannot read (chrome://, the web store)
  }
}

async function dropSave(tabId: number) {
  await setTabState("save", tabId, undefined);
  await chrome.tabs.sendMessage(tabId, { type: "barHide" }, { frameId: 0 }).catch(() => undefined);
}

/** menu.html / bar.html, framed into the tab `sender.tab`. */
export async function handleFrame(req: FrameRequest, tabId: number): Promise<unknown> {
  if (req.type === "barInfo" || req.type === "barAction") {
    const p = await pendingSave(tabId);
    if (!p) return dropSave(tabId).then(() => null);
    // Only the bar this tab was just opened with may read or act.
    if (!p.token || req.token !== p.token) throw new Error("this save prompt is no longer active");
    if (req.type === "barInfo") return { kind: p.kind, host: new URL(p.url).host, username: p.username } satisfies BarInfo;
    if (req.action === "never") {
      const s = await getSettings();
      await setLocal("settings", { ...s, neverSave: [...s.neverSave, new URL(p.url).host] });
    } else if (req.action === "save") {
      if (p.kind === "update" && p.itemId) {
        const item = await coreCall<Record<string, any>>({ op: "getCipher", id: p.itemId });
        if (repromptPending(item)) throw new Error(REPROMPT_MESSAGE); // flagged after the prompt was queued
        await save({ ...item, login: { ...item.login, password: p.password } });
      } else {
        const u = new URL(p.url);
        await save({ type: 1, name: u.hostname, login: { username: p.username, password: p.password, uris: [{ uri: u.origin, match: null }] } });
      }
    }
    await dropSave(tabId);
    return null;
  }

  const ctx = await getTabState("inline", tabId);
  if (!ctx) throw new Error("no field is focused");
  // Only the menu this document opened may act: a copy of menu.html framed by the page has no nonce.
  if (req.nonce !== ctx.nonce) throw new Error("this menu is not the one opened for this page");
  if (req.type === "inlineUnlock") {
    await chrome.action.openPopup().catch(() => undefined);
    return null;
  }
  if (req.type === "inlinePasskey") {
    await touchAutoLock(); // a pick counts as activity
    await openConditional(tabId, ctx.frameId);
    return null;
  }
  if (!(await isUnlocked())) return { kind: ctx.kind, locked: true, items: [], passkey: false } satisfies MenuData;
  const available = await items(ctx.kind, ctx.url);
  const passkey = ctx.kind === "login" && (await conditionalReady(tabId, ctx.frameId));
  if (req.type === "inlineList") return { kind: ctx.kind, locked: false, items: available, passkey } satisfies MenuData;

  // inlineFill: only an item offered for this field and frame.
  if (!available.some((i) => i.id === req.id)) throw new Error("item not available here");
  // Only a pick counts as activity: a page can open the menu (and list it) on its own, in a loop.
  await touchAutoLock();
  // A flagged item needs the master password, and there is no place to ask for it inside the page:
  // send the user to the extension popup, where the unlock screen is one click away.
  if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: req.id }))) {
    await chrome.action.openPopup().catch(() => undefined);
    throw new Error(REPROMPT_MESSAGE);
  }
  const target = { tabId, frameIds: [ctx.frameId] };
  await chrome.tabs.sendMessage(tabId, { type: "inlineClose" }, { frameId: ctx.frameId }).catch(() => undefined);
  const origin = new URL(ctx.url).origin;
  let res: FillResult | undefined;
  if (ctx.kind === "login") {
    const { username, password, totp } = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id: req.id });
    res = (await chrome.scripting.executeScript({ target, func: fillInPage, args: [{ mode: "login", origin, username, password }] }))[0]?.result as FillResult | undefined;
    if (res?.filled) {
      await markUsed(req.id);
      if (totp && (await getSettings()).autoCopyTotp) await copyToClipboard(totp);
    }
  } else {
    const values = await coreCall<Record<string, string>>({ op: "formValues", id: req.id });
    res = (await chrome.scripting.executeScript({ target, func: fillInPage, args: [{ mode: "form", origin, values }] }))[0]?.result as FillResult | undefined;
  }
  await setTabState("inline", tabId, undefined);
  return res ?? { filled: false };
}
