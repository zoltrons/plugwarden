// Lock state and auto-lock (alarms + idle).
import { coreShutdown } from "./core.ts";
import { getSettings, updateSession } from "./store.ts";

export const AUTOLOCK_ALARM = "autolock";

export async function lockNow(): Promise<void> {
  await updateSession({ unlocked: false, pending: undefined });
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  await coreShutdown();
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

export async function onIdleStateChanged(state: string): Promise<void> {
  if (state !== "locked") return;
  if ((await getSettings()).lockOnSystemLock) await lockNow();
}
