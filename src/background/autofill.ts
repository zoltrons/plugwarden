// Autofill on the active tab from the popup, Ctrl+Shift+L or the context menu: functions from
// src/autofill/page.ts are injected with chrome.scripting (the required host permissions cover every tab).
import { type FillResult, fillForm, fillLogin, fillLoginIfEmpty, type PageLogin, readLogin } from "../autofill/page.ts";
import type { PageMatches, VaultItem } from "../shared/messages.ts";
import { pickPageLoadLogin } from "../shared/pageload.ts";
import { UserError } from "./account.ts";
import { coreAlive, coreCall } from "./core.ts";
import { touchAutoLock } from "./lock.ts";
import { getLocal, getSession, getSettings } from "./store.ts";
import { copyToClipboard, list, markUsed } from "./vault.ts";

export const CONTEXT_MENU_ID = "plugwarden-autofill";
export const AUTOFILL_COMMAND = "autofill-login";

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
}

function httpUrl(tab: { url?: string } | undefined): URL | undefined {
  try {
    const u = new URL(tab?.url ?? "");
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
}

async function matches(url: URL): Promise<VaultItem[]> {
  await list(); // make sure the worker has the vault loaded
  const { defaultUriMatch } = await getSettings();
  return coreCall<VaultItem[]>({ op: "matchUri", url: url.href, defaultMatch: defaultUriMatch });
}

/** Logins matching the tab, plus cards / identities when the user shows them in the tab view. */
export async function pageMatches(): Promise<PageMatches> {
  const url = httpUrl(await activeTab());
  if (!url) return { items: [] };
  const settings = await getSettings();
  const items = await matches(url);
  const wanted = [settings.showCardsOnTab ? 3 : 0, settings.showIdentitiesOnTab ? 4 : 0].filter(Boolean);
  if (wanted.length) items.push(...(await list()).items.filter((i) => wanted.includes(i.type) && !i.failed));
  return { host: url.host, items };
}

/**
 * Page-load autofill: fill the best login into the frame that reported the page. Mirrors the
 * official client: the per-item tri-state decides whether an item takes part, the last login used
 * for the site wins (else the first by name), and only empty fields are filled.
 */
export async function pageLoadFill(sender: chrome.runtime.MessageSender): Promise<FillResult> {
  const settings = await getSettings();
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  const url = httpUrl(sender);
  if (!settings.autofillOnPageLoad || tabId === undefined || frameId === undefined || !url) return { filled: false, reason: "noFields" };
  if (!(await getSession()).unlocked || !(await coreAlive())) return { filled: false, reason: "locked" };
  const pick = pickPageLoadLogin(await matches(url), settings.autofillOnPageLoadDefault, (await getLocal("lastUsed")) ?? {});
  if (!pick) return { filled: false, reason: "noMatch" };
  const { username, password, totp } = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id: pick.id });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: fillLoginIfEmpty,
    args: [url.origin, username, password],
  });
  const r = (res?.result as FillResult | undefined) ?? { filled: false };
  // The user did not pick this login, but the official client still copies the code.
  if (r.filled && totp && settings.autoCopyTotp) await copyToClipboard(totp);
  await touchAutoLock();
  return r;
}

/** Fills `id` (or the first match) into the tab's top frame. Only items saved for this site are filled. */
export async function fillTab(tab: chrome.tabs.Tab | undefined, id?: string): Promise<FillResult> {
  const url = httpUrl(tab);
  if (!url || tab?.id === undefined) throw new UserError("invalid", "This page cannot be filled");
  let item: VaultItem | undefined;
  let values: Record<string, string> | undefined;
  if (id) {
    // The "On this site" list may offer a card or identity: fill it by its own field map.
    const cipher = await coreCall<Record<string, unknown>>({ op: "getCipher", id }).catch(() => undefined);
    if (!cipher) return { filled: false, reason: "noMatch" };
    const type = Number(cipher.type);
    if (type === 1) {
      if (!(await matches(url)).some((i) => i.id === id)) return { filled: false, reason: "noMatch" };
    } else if (type === 3 || type === 4) {
      values = await coreCall<Record<string, string>>({ op: "formValues", id });
    } else return { filled: false, reason: "noMatch" };
  } else {
    item = (await matches(url))[0];
    if (!item) return { filled: false, reason: "noMatch" };
    id = item.id;
  }
  const target = { tabId: tab.id, frameIds: [0] };
  let r: FillResult;
  let totp: string | undefined;
  if (values) {
    const [res] = await chrome.scripting.executeScript({ target, func: fillForm, args: [url.origin, values] });
    r = (res?.result as FillResult | undefined) ?? { filled: false };
  } else {
    const filled = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id });
    totp = filled.totp;
    const [res] = await chrome.scripting.executeScript({ target, func: fillLogin, args: [url.origin, filled.username, filled.password] });
    r = (res?.result as FillResult | undefined) ?? { filled: false };
  }
  if (r.filled) {
    await markUsed(id);
    if (totp && (await getSettings()).autoCopyTotp) await copyToClipboard(totp);
  }
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
    if ((await getSettings()).contextMenu) {
      const contexts: ["editable"] = ["editable"];
      chrome.contextMenus.create({ id: CONTEXT_MENU_ID, title: chrome.i18n.getMessage("ctxAutofill"), contexts }, ignoreError);
      for (const i of items)
        chrome.contextMenus.create({ id: `${CONTEXT_MENU_ID}:${i.id}`, parentId: CONTEXT_MENU_ID, title: i.sub ? `${i.name} (${i.sub})` : i.name, contexts }, ignoreError);
    }
    const badge = (tabId: number | undefined, text: string) => (tabId === undefined ? undefined : chrome.action.setBadgeText({ tabId, text }));
    if (unlocked) await badge(tab?.id, items.length ? String(items.length) : "");
    else await Promise.all((await chrome.tabs.query({})).map((t) => badge(t.id, "")));
  }).catch((e: unknown) => console.warn("tab ui", e));
  return tabUi;
}

/** Context menu: the parent entry fills the first match; a child entry fills that login. */
export async function onContextMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (!(await getSettings()).contextMenu) return undefined;
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
