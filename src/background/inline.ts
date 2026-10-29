// Inline menu and save/update bar. The content script reports focused fields and submitted logins;
// menu.html / bar.html (extension pages framed into the site) ask for data and act. Matching always
// uses the URL of the frame the field is in, as reported by the browser (sender.url).
import { type FillResult, fillForm, fillLogin } from "../autofill/page.ts";
import type { BarInfo, FieldKind, FrameRequest, MenuData, MenuItem, PageRequest, VaultItem } from "../shared/messages.ts";
import { coreAlive, coreCall } from "./core.ts";
import { touchAutoLock } from "./lock.ts";
import { pageLoadFill } from "./autofill.ts";
import { conditionalReady, openConditional } from "./passkey.ts";
import { getLocal, getSession, getSettings, getTabState, setLocal, setTabState } from "./store.ts";
import { copyToClipboard, list, markUsed, save } from "./vault.ts";

export interface InlineContext {
  frameId: number;
  url: string;
  kind: FieldKind;
}

export interface PendingSave {
  kind: "add" | "update";
  url: string;
  username: string;
  password: string;
  itemId?: string;
  /** epoch ms */
  expiresAt: number;
}

const SAVE_TTL_MS = 5 * 60_000;

const httpUrl = (u: string | undefined) => (u && /^https?:/.test(u) ? u : undefined);
const unlocked = async () => (await getSession()).unlocked && (await coreAlive());

async function items(kind: FieldKind, url: string): Promise<MenuItem[]> {
  const pick = ({ id, type, name, sub }: VaultItem) => ({ id, type, name, sub });
  if (kind === "login") {
    await list(); // vault loaded into the worker
    const { defaultUriMatch } = await getSettings();
    return (await coreCall<VaultItem[]>({ op: "matchUri", url, defaultMatch: defaultUriMatch })).map(pick);
  }
  const settings = await getSettings();
  if (kind === "card" && !settings.inlineMenuCards) return [];
  if (kind === "identity" && !settings.inlineMenuIdentities) return [];
  const type = kind === "card" ? 3 : 4;
  return (await list()).items.filter((i) => i.type === type && !i.failed).map(pick);
}


/** Content script: `rows` tells it how tall the menu is, 0 = do not show one. */
export async function handlePage(req: PageRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (req.type === "pageLoad") return pageLoadFill(sender);
  const url = httpUrl(sender.url);
  const tabId = sender.tab?.id;
  if (!url || tabId === undefined || sender.frameId === undefined) return { rows: 0 };
  if (req.type === "inlineFocus") {
    if (!(await getSettings()).inlineMenu || !(await getLocal("account"))) return { rows: 0 };
    await setTabState("inline", tabId, { frameId: sender.frameId, url, kind: req.kind });
    if (!(await unlocked())) return { rows: 1 }; // "Unlock to fill"
    const logins = (await items(req.kind, url)).length;
    // A website waiting on a conditional passkey request gets one extra row for it.
    const passkey = req.kind === "login" && (await conditionalReady(tabId, sender.frameId));
    return { rows: logins + (passkey ? 1 : 0) };
  }
  await loginSubmitted(tabId, url, req.username, req.password);
  return null;
}

async function loginSubmitted(tabId: number, url: string, username: string, password: string) {
  const settings = await getSettings();
  const host = new URL(url).host;
  if (!settings.savePrompt || settings.neverSave.includes(host) || !(await unlocked())) return;
  await list();
  const matches = await coreCall<VaultItem[]>({ op: "matchUri", url, defaultMatch: settings.defaultUriMatch });
  const same = matches.find((m) => m.sub === username && !m.readOnly);
  let pending: PendingSave | undefined;
  if (!same) pending = { kind: "add", url, username, password, expiresAt: Date.now() + SAVE_TTL_MS };
  else if ((await coreCall<{ password: string }>({ op: "fillData", id: same.id })).password !== password)
    pending = { kind: "update", url, username, password, itemId: same.id, expiresAt: Date.now() + SAVE_TTL_MS };
  if (!pending) return;
  await setTabState("save", tabId, pending);
  await showBar(tabId);
}

/** Also called when the tab finishes loading: logins are usually submitted right before a navigation. */
export async function showBar(tabId: number): Promise<void> {
  const p = await getTabState("save", tabId);
  if (p && p.expiresAt > Date.now()) await chrome.tabs.sendMessage(tabId, { type: "barShow" }, { frameId: 0 }).catch(() => undefined);
}

async function dropSave(tabId: number) {
  await setTabState("save", tabId, undefined);
  await chrome.tabs.sendMessage(tabId, { type: "barHide" }, { frameId: 0 }).catch(() => undefined);
}

/** menu.html / bar.html, framed into the tab `sender.tab`. */
export async function handleFrame(req: FrameRequest, tabId: number): Promise<unknown> {
  if (req.type === "barInfo" || req.type === "barAction") {
    const p = await getTabState("save", tabId);
    if (!p || p.expiresAt < Date.now()) return dropSave(tabId).then(() => null);
    if (req.type === "barInfo") return { kind: p.kind, host: new URL(p.url).host, username: p.username } satisfies BarInfo;
    if (req.action === "never") {
      const s = await getSettings();
      await setLocal("settings", { ...s, neverSave: [...s.neverSave, new URL(p.url).host] });
    } else if (req.action === "save") {
      if (p.kind === "update" && p.itemId) {
        const item = await coreCall<Record<string, any>>({ op: "getCipher", id: p.itemId });
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
  if (req.type === "inlineUnlock") {
    await chrome.action.openPopup().catch(() => undefined);
    return null;
  }
  if (req.type === "inlinePasskey") {
    await openConditional(tabId, ctx.frameId);
    return null;
  }
  if (!(await unlocked())) return { kind: ctx.kind, locked: true, items: [], passkey: false } satisfies MenuData;
  await touchAutoLock();
  const available = await items(ctx.kind, ctx.url);
  const passkey = ctx.kind === "login" && (await conditionalReady(tabId, ctx.frameId));
  if (req.type === "inlineList") return { kind: ctx.kind, locked: false, items: available, passkey } satisfies MenuData;

  // inlineFill: only an item offered for this field and frame.
  if (!available.some((i) => i.id === req.id)) throw new Error("item not available here");
  const target = { tabId, frameIds: [ctx.frameId] };
  await chrome.tabs.sendMessage(tabId, { type: "inlineClose" }, { frameId: ctx.frameId }).catch(() => undefined);
  const origin = new URL(ctx.url).origin;
  let res: FillResult | undefined;
  if (ctx.kind === "login") {
    const { username, password, totp } = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id: req.id });
    res = (await chrome.scripting.executeScript({ target, func: fillLogin, args: [origin, username, password] }))[0]?.result;
    if (res?.filled) {
      await markUsed(req.id);
      if (totp && (await getSettings()).autoCopyTotp) await copyToClipboard(totp);
    }
  } else {
    const values = await coreCall<Record<string, string>>({ op: "formValues", id: req.id });
    res = (await chrome.scripting.executeScript({ target, func: fillForm, args: [origin, values] }))[0]?.result;
  }
  await setTabState("inline", tabId, undefined);
  return res ?? { filled: false };
}
