// Service worker entry. Stateless: listeners are registered synchronously at top level, every
// handler reads its state from chrome.storage.
import { type ErrorCode, PASSKEY_PORT, type PageRequest, parseFrameRequest, parsePageRequest, parseRequest, type Request, type Response, type State } from "../shared/messages.ts";
import { ValidationError } from "../shared/validate.ts";
import { getServerInfo } from "../transport/config.ts";
import { normalizeServerUrl, originPattern } from "../shared/url.ts";
import { NetworkError } from "../transport/http.ts";
import {
  cancelTwoFactor,
  confirmReprompt,
  finishSso,
  login,
  removeBiometric,
  setBiometric,
  setPin,
  startSso,
  logout,
  sendTwoFactorEmail,
  submitTwoFactor,
  unlock,
  unlockWithBiometric,
  unlockWithPin,
  UserError,
} from "./account.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { coreAlive, coreCall } from "./core.ts";
import { AUTOLOCK_ALARM, lockNow, touchAutoLock } from "./lock.ts";
import {
  getLocal,
  getSession,
  getSettings,
  clearTabState,
  restrictStorageAccess,
  setDefaultManager,
  setLocal,
  updateSession,
} from "./store.ts";
import { handleFrame, handlePage, showBar } from "./inline.ts";
import { ensurePasskeyScripts, onPasskeyPort, onWindowRemoved, passkeyDecision, passkeyPrompt } from "./passkey.ts";
import { AUTOFILL_COMMAND, autofillFromGesture, fillActiveTab, onContextMenu, pageMatches, readPageLogin, updateTabUi } from "./autofill.ts";
import { addAttachment, addGeneratorHistory, CLIPBOARD_ALARM, downloadAttachment, exportVault, importVault, clearClipboard, clearGeneratorHistory, deleteFolder, generatorHistory, deleteSend, getSend, purge, removeSendPassword, restore, saveFolder, scheduleClipboardClear, list as vaultList, requireUnlocked, save, saveSend, sendList, sync, trash } from "./vault.ts";

async function getState(): Promise<State> {
  const [server, account, session, settings, vault, bio] = await Promise.all([
    getLocal("server"),
    getLocal("account"),
    getSession(),
    getSettings(),
    getLocal("vault"),
    getLocal("biometric"),
  ]);
  const base = { settings, serverUrl: server?.url, serverVersion: server?.version, syncedAt: vault?.syncedAt, ...(session.ssoError ? { ssoError: session.ssoError } : {}) };
  if (!server) return { phase: "setup", ...base };
  if (session.pending && session.pending.expiresAt > Date.now())
    return { phase: "twoFactor", ...base, email: session.pending.email, twoFactor: session.pending.challenge };
  // An abandoned login attempt (popup closed mid-2FA) still holds a derived master key in the crypto
  // worker: drop it as soon as we notice it has expired.
  if (session.pending) await cancelTwoFactor();
  if (!account) return { phase: "loggedOut", ...base };
  let unlocked = session.unlocked;
  if (unlocked && !(await coreAlive())) {
    // The offscreen document (and with it the keys) is gone, e.g. after an extension reload.
    await updateSession({ unlocked: false });
    unlocked = false;
  }
  const pin = { pinSet: !!account.protectedPin, pinUnlock: !!account.protectedPin && session.pin?.email === account.email };
  const biometric = bio && bio.email === account.email ? { credentialId: bio.credentialId, prfSalt: bio.prfSalt } : undefined;
  return { phase: unlocked ? "unlocked" : "locked", ...base, ...pin, ...(biometric ? { biometric } : {}), email: account.email };
}

async function setServer(input: string): Promise<void> {
  let url: string;
  try {
    url = normalizeServerUrl(input);
  } catch (e) {
    throw new UserError("invalid", (e as Error).message);
  }
  // The popup requests the optional host permission inside the click handler (user gesture).
  if (!(await chrome.permissions.contains({ origins: [originPattern(url)] })))
    throw new UserError("permission", "Access to the server was not granted");
  const info = await getServerInfo(url).catch((e: unknown) => {
    if (e instanceof NetworkError) throw e;
    throw new UserError("badServer", "This does not look like a Bitwarden-compatible server");
  });
  const previous = await getLocal("server");
  if (previous && previous.url !== url) await logout();
  await setLocal("server", { url, version: info.version, name: info.name });
}

/** Vault requests return their own data; everything else returns the new State. */
async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "vaultList":
    case "sync":
    case "getItem":
    case "saveItem":
    case "deleteItem":
    case "restoreItem":
    case "purgeItem":
    case "downloadAttachment":
    case "addAttachment":
    case "exportVault":
    case "importVault":
    case "saveFolder":
    case "deleteFolder":
    case "totp":
    case "generate":
    case "generatorHistory":
    case "generatorHistoryAdd":
    case "generatorHistoryClear":
    case "sendList":
    case "getSend":
    case "saveSend":
    case "deleteSend":
    case "removeSendPassword": {
      await requireUnlocked();
      await touchAutoLock();
      if (req.type === "vaultList") return vaultList();
      if (req.type === "sync") return (await sync(req.force)) ? vaultList() : null;
      if (req.type === "getItem") {
        // A flagged item is not decrypted into the popup until the master password is re-entered.
        const item = await coreCall<Record<string, unknown>>({ op: "getCipher", id: req.id });
        if (repromptPending(item)) throw new UserError("reprompt", REPROMPT_MESSAGE);
        return item;
      }
      if (req.type === "saveItem") return save(req.item);
      if (req.type === "deleteItem") return trash(req.id);
      if (req.type === "restoreItem") return restore(req.id);
      if (req.type === "purgeItem") return purge(req.id);
      if (req.type === "downloadAttachment") return downloadAttachment(req.cipherId, req.attachmentId);
      if (req.type === "addAttachment") return addAttachment(req.cipherId, req.file);
      if (req.type === "exportVault") return exportVault(req.password);
      if (req.type === "importVault") return importVault(req.text);
      if (req.type === "saveFolder") return saveFolder(req.name, req.id);
      if (req.type === "deleteFolder") return deleteFolder(req.id);
      if (req.type === "totp") {
        const item = await coreCall<Record<string, unknown>>({ op: "getCipher", id: req.id });
        if (repromptPending(item)) throw new UserError("reprompt", REPROMPT_MESSAGE);
        return coreCall({ op: "totp", id: req.id });
      }
      if (req.type === "generatorHistory") return generatorHistory();
      if (req.type === "generatorHistoryAdd") return addGeneratorHistory(req.value);
      if (req.type === "generatorHistoryClear") return clearGeneratorHistory();
      if (req.type === "sendList") return sendList();
      if (req.type === "getSend") return getSend(req.id);
      if (req.type === "saveSend") return saveSend(req.send, req.file);
      if (req.type === "deleteSend") return deleteSend(req.id);
      if (req.type === "removeSendPassword") return removeSendPassword(req.id);
      return coreCall({ op: "generate", options: req.options });
    }
    case "pageMatches":
    case "fill":
    case "readPageLogin":
      await requireUnlocked();
      await touchAutoLock();
      if (req.type === "pageMatches") return pageMatches();
      if (req.type === "fill") return fillActiveTab(req.id);
      return readPageLogin();
    case "clipboardCopied":
      await scheduleClipboardClear();
      return null;
    case "getState":
      break;
    case "setServer":
      await setServer(req.url);
      break;
    case "login":
      await login(req.email, req.password);
      break;
    case "twoFactorSubmit":
      await submitTwoFactor(req.provider, req.token, req.remember);
      break;
    case "twoFactorSendEmail":
      await sendTwoFactorEmail();
      break;
    case "twoFactorCancel":
      await cancelTwoFactor();
      break;
    case "ssoStart":
      await startSso();
      break;
    case "unlock":
      await unlock(req.password);
      break;
    case "unlockPin":
      await unlockWithPin(req.pin);
      break;
    case "unlockBiometric":
      await unlockWithBiometric(req.prf);
      break;
    case "setBiometric":
      await requireUnlocked();
      await setBiometric(req.credentialId, req.prfSalt, req.prf);
      break;
    case "removeBiometric":
      await requireUnlocked();
      await removeBiometric();
      break;
    case "setPin":
      await requireUnlocked();
      await setPin(req.pin);
      break;
    case "confirmReprompt":
      await requireUnlocked();
      await confirmReprompt(req.id, req.password);
      break;
    case "lock":
      await lockNow();
      break;
    case "logout":
      await logout();
      break;
    case "passkeyPrompt":
      return passkeyPrompt(req.id);
    case "passkeyDecision":
      return passkeyDecision(req.id, req.action, req.itemId, req.credentialId);
    case "setSettings": {
      const current = await getSettings();
      await setLocal("settings", {
        ...current,
        autoLockMinutes: req.autoLockMinutes ?? current.autoLockMinutes,
        timeoutAction: req.timeoutAction ?? current.timeoutAction,
        lockOnSystemLock: req.lockOnSystemLock ?? current.lockOnSystemLock,
        inlineMenu: req.inlineMenu ?? current.inlineMenu,
        savePrompt: req.savePrompt ?? current.savePrompt,
        favicons: req.favicons ?? current.favicons,
        autoCopyTotp: req.autoCopyTotp ?? current.autoCopyTotp,
        defaultUriMatch: req.defaultUriMatch ?? current.defaultUriMatch,
        clearClipboardDelay: req.clearClipboardDelay ?? current.clearClipboardDelay,
        autofillOnPageLoad: req.autofillOnPageLoad ?? current.autofillOnPageLoad,
        autofillOnPageLoadDefault: req.autofillOnPageLoadDefault ?? current.autofillOnPageLoadDefault,
        inlineMenuCards: req.inlineMenuCards ?? current.inlineMenuCards,
        inlineMenuIdentities: req.inlineMenuIdentities ?? current.inlineMenuIdentities,
        contextMenu: req.contextMenu ?? current.contextMenu,
        showCardsOnTab: req.showCardsOnTab ?? current.showCardsOnTab,
        showIdentitiesOnTab: req.showIdentitiesOnTab ?? current.showIdentitiesOnTab,
        neverSave: req.clearNeverSave ? [] : req.removeNeverSave ? current.neverSave.filter((h) => h !== req.removeNeverSave) : current.neverSave,
      });
      break;
    }
    case "setDefaultManager":
      await setDefaultManager(req.enabled);
      break;
  }
  const state = await getState();
  if (state.phase === "unlocked") await touchAutoLock();
  return state;
}

function toError(e: unknown): Response<unknown> {
  let code: ErrorCode | undefined;
  let error = e instanceof Error ? e.message : String(e);
  if (e instanceof UserError) code = e.code;
  else if (e instanceof ValidationError) code = "invalid";
  else if (e instanceof NetworkError) {
    code = "network";
    error = "Cannot reach the server";
  } else console.error(e);
  return { ok: false, error, ...(code ? { code } : {}) };
}

/**
 * Our own extension page behind `url`, as a path. Matched by path, not by a compare against
 * `chrome.runtime.getURL()`: menu.html/bar.html are web-accessible resources with `use_dynamic_url`,
 * so `getURL()` returns a per-session dynamic id while `sender.url` carries the static one.
 */
const extensionPath = (url: string | undefined): string | undefined => {
  if (!url?.startsWith("chrome-extension://")) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
};

const UI_PATHS = ["/popup.html", "/sidepanel.html"];
const FRAME_PATHS = ["/menu.html", "/bar.html"];

// Serialize state-changing requests so e.g. a double-clicked "Log in" cannot interleave.
let queue: Promise<unknown> = Promise.resolve();
/** Submitted logins waiting in `queue`, at most one per tab (the latest). */
const submits = new Map<number, { req: PageRequest; sender: chrome.runtime.MessageSender }>();

chrome.runtime.onMessage.addListener((msg: unknown, sender, reply: (r: Response<unknown>) => void) => {
  // The SSO callback content script (registered only for <server>/sso-connector.html during a login).
  if (sender.id === chrome.runtime.id && sender.tab?.id !== undefined && sender.url && (msg as { type?: unknown } | null)?.type === "ssoCallback") {
    const [url, tabId] = [sender.url, sender.tab.id];
    queue = queue.then(() => finishSso(url, tabId)).catch((e: unknown) => console.error(e));
    return false;
  }
  // URL check is enough: our pages are not web-accessible, so only the extension can load them (also when opened in a tab).
  if (sender.id !== chrome.runtime.id) return false;
  const tabId = sender.tab?.id;
  // Our menu/bar iframes inside a website tab, and the content script on that website.
  const frame = FRAME_PATHS.includes(extensionPath(sender.url) ?? "");
  if (tabId !== undefined && (frame || /^https?:/.test(sender.url ?? ""))) {
    let run: () => Promise<unknown>;
    let read: boolean;
    try {
      if (frame) {
        const req = parseFrameRequest(msg);
        run = () => handleFrame(req, tabId);
        read = req.type === "inlineList" || req.type === "barInfo";
      } else {
        const req = parsePageRequest(msg);
        read = req.type === "inlineFocus";
        if (req.type === "loginSubmitted") {
          // A page can fire submits in a loop: keep one queued per tab, carrying the latest values.
          const queued = submits.has(tabId);
          submits.set(tabId, { req, sender });
          if (queued) {
            reply({ ok: true, data: null });
            return false;
          }
          run = () => {
            const latest = submits.get(tabId)!;
            submits.delete(tabId);
            return handlePage(latest.req, latest.sender);
          };
        } else run = () => handlePage(req, sender);
      }
    } catch (e) {
      reply(toError(e));
      return false;
    }
    const go = () => run().then((data) => reply({ ok: true, data } as Response<unknown>), (e: unknown) => reply(toError(e)));
    // Menu reads must not wait behind an unlock (Argon2id) or a sync; fills and saves stay in order.
    // A page-load opportunity changes nothing the badge or menu shows, so it skips the refresh.
    const refresh = () => (frame || (msg as { type?: unknown }).type !== "pageLoad" ? updateTabUi() : undefined);
    if (read) void go();
    else queue = queue.then(go, go).then(refresh);
    return true;
  }
  if (!UI_PATHS.includes(extensionPath(sender.url) ?? "")) return false;
  if ((msg as { target?: unknown } | null)?.target !== undefined) return false; // offscreen traffic
  let req: Request;
  try {
    req = parseRequest(msg);
  } catch (e) {
    reply(toError(e));
    return false;
  }
  const run = () => handle(req).then((data) => reply({ ok: true, data } as Response<unknown>), (e: unknown) => reply(toError(e)));
  // Reads run immediately; anything that changes state or talks to the server is queued, and may
  // change what the badge and the context menu show (unlock, lock, sync, edits).
  if (["getState", "vaultList", "getItem", "totp", "generate", "generatorHistory", "downloadAttachment", "pageMatches", "readPageLogin", "sendList", "getSend", "passkeyPrompt"].includes(req.type)) void run();
  else queue = queue.then(run, run).then(updateTabUi);
  return true;
});

/** Auto-lock, system lock and browser restart: lock, or log out if the user chose that. */
const timeout = async () => {
  await ((await getSettings()).timeoutAction === "logout" ? logout() : lockNow());
  await updateTabUi();
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) void timeout();
  if (alarm.name === CLIPBOARD_ALARM) void clearClipboard();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PASSKEY_PORT) onPasskeyPort(port);
});

chrome.windows.onRemoved.addListener(onWindowRemoved);

chrome.tabs.onRemoved.addListener((tabId) => void clearTabState(tabId));

// A login is usually submitted right before a navigation: show the save bar once the next page is there.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  void showBar(tabId);
  if (tab.active) void updateTabUi();
});

chrome.tabs.onActivated.addListener(() => void updateTabUi());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void updateTabUi();
});

chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "locked" && (await getSettings()).lockOnSystemLock) await timeout();
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === AUTOFILL_COMMAND) void autofillFromGesture(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => void onContextMenu(info, tab));

chrome.runtime.onInstalled.addListener(() => {
  void restrictStorageAccess();
  void ensurePasskeyScripts(); // passkeys are always on, like the official clients
  void updateTabUi();
});

// Test-only hook (commands and context menus cannot be triggered from automation); compiled out otherwise.
declare const E2E: boolean;
if (E2E) Object.assign(globalThis, { plugwardenTest: { autofillFromGesture, onContextMenu } });
chrome.runtime.onStartup.addListener(() => {
  void restrictStorageAccess();
  void ensurePasskeyScripts();
  // The restart already locked the vault (session storage is gone); "log out" goes one step further.
  void timeout();
});

// Also on a plain service-worker start (registration is idempotent): covers a fresh install where the
// worker was already running, and browsers that drop registered scripts.
void ensurePasskeyScripts().catch((e: unknown) => console.error(e));
// Content scripts must never be able to read our storage: apply the level on every worker start, so a
// cold start that precedes onStartup cannot leave the cache readable by a page.
void restrictStorageAccess().catch((e: unknown) => console.error(e));
