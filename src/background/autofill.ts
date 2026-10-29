// Autofill on the active tab from the popup, Ctrl+Shift+L or the context menu: functions from
// src/autofill/page.ts are injected with chrome.scripting (the required host permissions cover every tab).
import { type FillResult, fillLogin, type PageLogin, readLogin } from "../autofill/page.ts";
import type { PageMatches, VaultItem } from "../shared/messages.ts";
import { UserError } from "./account.ts";
import { coreAlive, coreCall } from "./core.ts";
import { touchAutoLock } from "./lock.ts";
import { getSession, getSettings } from "./store.ts";
import { copyToClipboard, list } from "./vault.ts";

export const CONTEXT_MENU_ID = "plugwarden-autofill";
export const AUTOFILL_COMMAND = "autofill-login";

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
}

function httpUrl(tab: chrome.tabs.Tab | undefined): URL | undefined {
  try {
    const u = new URL(tab?.url ?? "");
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
}

async function matches(url: URL): Promise<VaultItem[]> {
  await list(); // make sure the worker has the vault loaded
  return coreCall<VaultItem[]>({ op: "matchUri", url: url.href });
}

export async function pageMatches(): Promise<PageMatches> {
  const url = httpUrl(await activeTab());
  return url ? { host: url.host, items: await matches(url) } : { items: [] };
}

/** Fills `id` (or the first match) into the tab's top frame. Only items saved for this site are filled. */
export async function fillTab(tab: chrome.tabs.Tab | undefined, id?: string): Promise<FillResult> {
  const url = httpUrl(tab);
  if (!url || tab?.id === undefined) throw new UserError("invalid", "This page cannot be filled");
  const items = await matches(url);
  const item = id ? items.find((i) => i.id === id) : items[0];
  if (!item) return { filled: false, reason: "noMatch" };
  const { username, password, totp } = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id: item.id });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: fillLogin,
    args: [url.origin, username, password],
  });
  const r = (res?.result as FillResult | undefined) ?? { filled: false };
  if (r.filled && totp && (await getSettings()).autoCopyTotp) await copyToClipboard(totp);
  return r;
}

export const fillActiveTab = async (id: string) => fillTab(await activeTab(), id);

// Calls overlap (tab switch + page load); menu ids must not be created twice.
let tabUi: Promise<void> = Promise.resolve();
const ignoreError = () => void chrome.runtime.lastError;

/**
 * Action badge with the number of logins for the active tab, and one context-menu entry per login
 * under "Fill with Plugwarden". Locked: no badges anywhere, and the bare entry opens the popup.
 */
export function updateTabUi(): Promise<void> {
  tabUi = tabUi.then(async () => {
    const tab = await activeTab();
    const url = httpUrl(tab);
    const unlocked = (await getSession()).unlocked && (await coreAlive());
    const items = unlocked && url ? await matches(url) : [];
    await chrome.contextMenus.removeAll();
    const contexts: ["editable"] = ["editable"];
    chrome.contextMenus.create({ id: CONTEXT_MENU_ID, title: chrome.i18n.getMessage("ctxAutofill"), contexts }, ignoreError);
    for (const i of items)
      chrome.contextMenus.create({ id: `${CONTEXT_MENU_ID}:${i.id}`, parentId: CONTEXT_MENU_ID, title: i.sub ? `${i.name} (${i.sub})` : i.name, contexts }, ignoreError);
    const badge = (tabId: number | undefined, text: string) => (tabId === undefined ? undefined : chrome.action.setBadgeText({ tabId, text }));
    if (unlocked) await badge(tab?.id, items.length ? String(items.length) : "");
    else await Promise.all((await chrome.tabs.query({})).map((t) => badge(t.id, "")));
  }).catch((e: unknown) => console.warn("tab ui", e));
  return tabUi;
}

/** Context menu: the parent entry fills the first match; a child entry fills that login. */
export function onContextMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  const id = String(info.menuItemId);
  if (id === CONTEXT_MENU_ID) return autofillFromGesture(tab);
  if (id.startsWith(`${CONTEXT_MENU_ID}:`)) return autofillFromGesture(tab, id.slice(CONTEXT_MENU_ID.length + 1));
  return undefined;
}

export async function readPageLogin(): Promise<PageLogin | null> {
  const tab = await activeTab();
  if (!httpUrl(tab) || tab?.id === undefined) return null;
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: readLogin });
  return (res?.result as PageLogin | null | undefined) ?? null;
}

/** Keyboard shortcut / context menu: fill the first match, or open the popup (locked, or nothing to fill). */
export async function autofillFromGesture(tab: chrome.tabs.Tab | undefined, id?: string): Promise<FillResult> {
  if (!(await getSession()).unlocked || !(await coreAlive())) {
    await chrome.action.openPopup().catch(() => undefined);
    return { filled: false, reason: "locked" };
  }
  await touchAutoLock();
  const r = await fillTab(tab, id).catch((e: unknown): FillResult => (console.warn("autofill", e), { filled: false, reason: "error" }));
  if (!r.filled) await chrome.action.openPopup().catch(() => undefined);
  return r;
}
