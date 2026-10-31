// Autofill on the active tab from the popup, Ctrl+Shift+L or the context menu.
import type { FillResult, PageLogin } from "../autofill/types.ts";
import type { PageMatches, VaultItem } from "../shared/messages.ts";
import { pickPageLoadLogin } from "../shared/pageload.ts";
import { UserError } from "./account.ts";
import { coreCall } from "./core.ts";
import { type FillRequest, fillInFrames, pageCall } from "./engine.ts";
import { touchAutoLock } from "./lock.ts";
import { getLocal, getSettings } from "./store.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { copyToClipboard, ensureLoaded, isUnlocked, list, markUsed } from "./vault.ts";

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
  await ensureLoaded();
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
  return { host: url.host, origin: url.origin, items };
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
  if (!(await isUnlocked())) return { filled: false, reason: "locked" };
  // Items flagged for a master-password re-prompt never fill on page load (no user to ask).
  const pick = pickPageLoadLogin((await matches(url)).filter((i) => !i.reprompt), settings.autofillOnPageLoadDefault, (await getLocal("lastUsed")) ?? {});
  if (!pick) return { filled: false, reason: "noMatch" };
  const { username, password, totp } = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id: pick.id });
  const [res] = await fillInFrames(tabId, { frameIds: [frameId] }, { mode: "login", origin: url.origin, username, password, onlyEmpty: true });
  const r = res?.result ?? { filled: false };
  if (r.filled) await closeInlineMenu(tabId, frameId);
  // The user did not pick this login, but the official client still copies the code.
  // No touchAutoLock: a page load is not user activity, and a page that reloads itself must not keep the vault open.
  if (r.filled && totp && settings.autoCopyTotp) await copyToClipboard(totp);
  return r;
}

/**
 * Runs a page fill, top frame first. A login form is often inside a (same-origin) iframe, so when the
 * top frame has nothing the fill is retried in every frame; the origin check inside refuses foreign ones.
 * A login goes password-first: an e-mail box in the top frame must not win over a real form in an iframe,
 * so the username-only step is the last resort.
 */
async function fillFrames(tabId: number, req: FillRequest): Promise<FillResult> {
  const filledIn = (res: { result: FillResult; frameId: number }[]) => res.find((r) => r.result.filled);
  const strict = req.mode === "login" ? { ...req, passwordOnly: true } : req;
  const top = await fillInFrames(tabId, { frameIds: [0] }, strict);
  const hit = filledIn(top) ?? filledIn(await fillInFrames(tabId, { allFrames: true }, strict));
  if (hit) {
    await closeInlineMenu(tabId, hit.frameId);
    return hit.result;
  }
  if (req.mode !== "login") return top[0]?.result ?? { filled: false };
  const last = (await fillInFrames(tabId, { frameIds: [0] }, req))[0]?.result;
  if (last?.filled) await closeInlineMenu(tabId);
  return last ?? { filled: false };
}

/**
 * The fill focuses the fields it writes, which would open the inline menu on top of a fill the user just
 * asked for. `inlineClose` also keeps the menu quiet for a moment (content.ts).
 */
function closeInlineMenu(tabId: number, frameId?: number) {
  return chrome.tabs.sendMessage(tabId, { type: "inlineClose" }, frameId === undefined ? {} : { frameId }).catch(() => undefined);
}

/** Fills `id` (or the first match) into the tab. Only items saved for this site are filled. */
export async function fillTab(tab: chrome.tabs.Tab | undefined, id?: string): Promise<FillResult> {
  const url = httpUrl(tab);
  if (!url || tab?.id === undefined) throw new UserError("invalid", "This page cannot be filled");
  let item: VaultItem | undefined;
  let values: Record<string, string> | undefined;
  if (id) {
    // The "On this site" list may offer a card or identity: fill it by its own field map.
    const cipher = await coreCall<VaultItem>({ op: "cipherSummary", id }).catch(() => undefined);
    if (!cipher) return { filled: false, reason: "noMatch" };
    if (repromptPending(cipher)) throw new UserError("reprompt", REPROMPT_MESSAGE);
    const type = cipher.type;
    if (type === 1) {
      if (!(await matches(url)).some((i) => i.id === id)) return { filled: false, reason: "noMatch" };
    } else if (type === 3 || type === 4) {
      values = await coreCall<Record<string, string>>({ op: "formValues", id });
    } else return { filled: false, reason: "noMatch" };
  } else {
    // "Fill the first match" is a fill nobody confirmed: skip items that need a re-prompt.
    item = (await matches(url)).filter((i) => !i.reprompt)[0];
    if (!item) return { filled: false, reason: "noMatch" };
    id = item.id;
  }
  let r: FillResult;
  let totp: string | undefined;
  if (values) {
    r = await fillFrames(tab.id, { mode: "form", origin: url.origin, values });
  } else {
    const filled = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id });
    totp = filled.totp;
    const { autosubmit } = await getSettings();
    r = await fillFrames(tab.id, { mode: "login", origin: url.origin, username: filled.username, password: filled.password, totp, autosubmit });
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
    const unlocked = await isUnlocked();
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
  const [res] = await pageCall<PageLogin | null>({ tabId: tab.id, frameIds: [0] }, "readLogin", undefined);
  const login = res?.result ?? null;
  return login && { ...login, url: tab.url! }; // the browser's URL, not the page's own location.href
}

/** Keyboard shortcut / context menu: fill the first match, or open the popup (locked, or nothing to fill). */
export async function autofillFromGesture(tab: chrome.tabs.Tab | undefined, id?: string): Promise<FillResult> {
  if (!(await isUnlocked())) {
    await chrome.action.openPopup().catch(() => undefined);
    return { filled: false, reason: "locked" };
  }
  await touchAutoLock();
  const r = await fillTab(tab, id).catch((e: unknown): FillResult => (console.warn("autofill", e), { filled: false, reason: "error" }));
  if (!r.filled) await chrome.action.openPopup().catch(() => undefined);
  return r;
}
