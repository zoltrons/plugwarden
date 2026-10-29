// Service worker entry. Stateless: listeners are registered synchronously at top level, every
// handler reads its state from chrome.storage.
import { type ErrorCode, parseRequest, type Request, type Response, type State } from "../shared/messages.ts";
import { ValidationError } from "../shared/validate.ts";
import { getServerInfo } from "../transport/config.ts";
import { normalizeServerUrl, originPattern } from "../shared/url.ts";
import { NetworkError } from "../transport/http.ts";
import {
  cancelTwoFactor,
  login,
  logout,
  sendTwoFactorEmail,
  submitTwoFactor,
  unlock,
  UserError,
} from "./account.ts";
import { coreAlive, coreCall } from "./core.ts";
import { AUTOLOCK_ALARM, lockNow, onIdleStateChanged, touchAutoLock } from "./lock.ts";
import {
  getLocal,
  getSession,
  getSettings,
  restrictStorageAccess,
  setLocal,
  updateSession,
} from "./store.ts";
import { CLIPBOARD_ALARM, clearClipboard, list as vaultList, requireUnlocked, save, sync, trash } from "./vault.ts";

async function getState(): Promise<State> {
  const [server, account, session, settings] = await Promise.all([
    getLocal("server"),
    getLocal("account"),
    getSession(),
    getSettings(),
  ]);
  const base = { settings, serverUrl: server?.url, serverVersion: server?.version };
  if (!server) return { phase: "setup", ...base };
  if (session.pending && session.pending.expiresAt > Date.now())
    return { phase: "twoFactor", ...base, email: session.pending.email, twoFactor: session.pending.challenge };
  if (!account) return { phase: "loggedOut", ...base };
  let unlocked = session.unlocked;
  if (unlocked && !(await coreAlive())) {
    // The offscreen document (and with it the keys) is gone, e.g. after an extension reload.
    await updateSession({ unlocked: false });
    unlocked = false;
  }
  return { phase: unlocked ? "unlocked" : "locked", ...base, email: account.email };
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
    case "totp":
    case "generate": {
      await requireUnlocked();
      await touchAutoLock();
      if (req.type === "vaultList") return vaultList();
      if (req.type === "sync") return (await sync(req.force)) ? vaultList() : null;
      if (req.type === "getItem") return coreCall({ op: "getCipher", id: req.id });
      if (req.type === "saveItem") return save(req.item);
      if (req.type === "deleteItem") return trash(req.id);
      if (req.type === "totp") return coreCall({ op: "totp", id: req.id });
      return coreCall({ op: "generate", options: req.options });
    }
    case "clipboardCopied":
      await chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: 0.5 });
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
    case "unlock":
      await unlock(req.password);
      break;
    case "lock":
      await lockNow();
      break;
    case "logout":
      await logout();
      break;
    case "setSettings": {
      const current = await getSettings();
      await setLocal("settings", {
        autoLockMinutes: req.autoLockMinutes ?? current.autoLockMinutes,
        lockOnSystemLock: req.lockOnSystemLock ?? current.lockOnSystemLock,
      });
      break;
    }
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

const POPUP_URL = chrome.runtime.getURL("popup.html");

// Serialize state-changing requests so e.g. a double-clicked "Log in" cannot interleave.
let queue: Promise<unknown> = Promise.resolve();

chrome.runtime.onMessage.addListener((msg: unknown, sender, reply: (r: Response<unknown>) => void) => {
  // URL check is enough: popup.html is not web-accessible, so only our own page can have it (also when opened in a tab).
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(POPUP_URL)) return false;
  if ((msg as { target?: unknown } | null)?.target !== undefined) return false; // offscreen traffic
  let req: Request;
  try {
    req = parseRequest(msg);
  } catch (e) {
    reply(toError(e));
    return false;
  }
  const run = () => handle(req).then((data) => reply({ ok: true, data } as Response<unknown>), (e: unknown) => reply(toError(e)));
  // Reads run immediately; anything that changes state or talks to the server is queued.
  if (["getState", "vaultList", "getItem", "totp", "generate"].includes(req.type)) void run();
  else queue = queue.then(run, run);
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) void lockNow();
  if (alarm.name === CLIPBOARD_ALARM) void clearClipboard();
});

chrome.idle.onStateChanged.addListener((state) => void onIdleStateChanged(state));

chrome.runtime.onInstalled.addListener(() => void restrictStorageAccess());
chrome.runtime.onStartup.addListener(() => void restrictStorageAccess());
