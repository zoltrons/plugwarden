// Autofill on the active tab. No persistent content script: functions from src/autofill/page.ts are
// injected on a user gesture (popup, Ctrl+Shift+L, context menu), which grants activeTab.
import { type FillResult, fillLogin, type PageLogin, readLogin } from "../autofill/page.ts";
import type { PageMatches, VaultItem } from "../shared/messages.ts";
import { UserError } from "./account.ts";
import { coreAlive, coreCall } from "./core.ts";
import { touchAutoLock } from "./lock.ts";
import { getSession } from "./store.ts";
import { list } from "./vault.ts";

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
  const { username, password } = await coreCall<{ username: string; password: string }>({ op: "fillData", id: item.id });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: fillLogin,
    args: [url.origin, username, password],
  });
  return (res?.result as FillResult | undefined) ?? { filled: false };
}

export const fillActiveTab = async (id: string) => fillTab(await activeTab(), id);

export async function readPageLogin(): Promise<PageLogin | null> {
  const tab = await activeTab();
  if (!httpUrl(tab) || tab?.id === undefined) return null;
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: readLogin });
  return (res?.result as PageLogin | null | undefined) ?? null;
}

/** Keyboard shortcut / context menu: fill the first match, or open the popup (locked, or nothing to fill). */
export async function autofillFromGesture(tab: chrome.tabs.Tab | undefined): Promise<FillResult> {
  if (!(await getSession()).unlocked || !(await coreAlive())) {
    await chrome.action.openPopup().catch(() => undefined);
    return { filled: false, reason: "locked" };
  }
  await touchAutoLock();
  const r = await fillTab(tab).catch((e: unknown): FillResult => (console.warn("autofill", e), { filled: false, reason: "error" }));
  if (!r.filled) await chrome.action.openPopup().catch(() => undefined);
  return r;
}
