// Lock state and auto-lock (alarms + idle).
import { coreShutdown } from "./core.ts";
import { revokeReprompts } from "./reprompt.ts";
import { getSettings, updateSession } from "./store.ts";

export const AUTOLOCK_ALARM = "autolock";

/**
 * The inline menu and the save bar are extension frames inside web pages, showing decrypted item names
 * and usernames. Locking must tear them down, or a page could keep them on screen after the lock.
 */
async function closeInPageUi(): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.allSettled(
    tabs.flatMap((t) =>
      t.id === undefined || !/^https?:/.test(t.url ?? "")
        ? []
        : [
            chrome.tabs.sendMessage(t.id, { type: "inlineClose" }).catch(() => undefined),
            chrome.tabs.sendMessage(t.id, { type: "barHide" }).catch(() => undefined),
          ],
    ),
  );
}

export async function lockNow(): Promise<void> {
  // First and synchronous: a re-prompt grant must survive no lock, even one that fails halfway.
  revokeReprompts();
  await updateSession({ unlocked: false, pending: undefined });
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  await coreShutdown();
  await closeInPageUi();
}

/** Called on unlock and on every popup interaction while unlocked. */
export async function touchAutoLock(): Promise<void> {
  const { autoLockMinutes } = await getSettings();
  if (autoLockMinutes < 0) {
    // "On browser restart": storage.session and the offscreen document die with the browser.
    await chrome.alarms.clear(AUTOLOCK_ALARM);
    return;
  }
  await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: Math.max(autoLockMinutes, 0.5) });
}
