// Vault orchestration in the service worker: encrypted cache in storage.local, sync, and writes.
// Decryption happens in the offscreen worker; the SW only moves encrypted JSON around.
import { CLEAR_CLIPBOARD_MS } from "../shared/constants.ts";
import type { HistoryEntry, SendItem, VaultItem, VaultList } from "../shared/messages.ts";
import { revisionDate } from "../transport/auth.ts";
import {
  addAttachment as apiAddAttachment,
  createFileSend,
  createSend,
  deleteFolder as apiDeleteFolder,
  deleteSend as apiDeleteSend,
  downloadAttachment as apiDownloadAttachment,
  fullSync,
  importCiphers,
  purgeCipher,
  removeSendPassword as apiRemoveSendPassword,
  restoreCipher,
  saveCipher,
  saveFolder as apiSaveFolder,
  trashCipher,
  updateSend,
  uploadSendFile,
  verifyPassword,
} from "../transport/vault.ts";
import { ApiError } from "../transport/http.ts";
import { accessToken, UserError, verifyMasterPassword } from "./account.ts";
import { coreAlive, coreCall } from "./core.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { getLocal, getSession, getSettings, removeLocal, setLocal, type VaultCache } from "./store.ts";

export const CLIPBOARD_ALARM = "clipboard";

export const isUnlocked = async (): Promise<boolean> => (await getSession()).unlocked && (await coreAlive());

export async function requireUnlocked(): Promise<void> {
  if (!(await isUnlocked())) throw new UserError("wrongPhase", "The vault is locked");
}

async function server(): Promise<string> {
  const s = await getLocal("server");
  if (!s) throw new UserError("wrongPhase", "No server configured");
  return s.url;
}

const load = (c: VaultCache) =>
  coreCall({ op: "loadVault", ciphers: c.ciphers, folders: c.folders, sends: c.sends ?? [], orgKeys: c.orgKeys, collections: c.collections ?? [], orgs: c.orgs ?? [] });

/** Full sync when the server's revision date moved (or `force`). Returns true if data changed. */
export async function sync(force: boolean): Promise<boolean> {
  const base = await server();
  const token = await accessToken();
  const cache = await getLocal("vault");
  const revision = await revisionDate(base, token);
  if (!force && cache && cache.revision >= revision) {
    await setLocal("vault", { ...cache, syncedAt: Date.now() });
    return false;
  }
  const r = await fullSync(base, token);
  const orgKeys = Object.fromEntries((r.profile.organizations ?? []).filter((o) => o.key).map((o) => [o.id, o.key!]));
  // shortcut: whole vault in one storage.local key (10 MB quota, no unlimitedStorage); move to IndexedDB if vaults outgrow it.
  const orgs = (r.profile.organizations ?? []).map((o) => ({ id: o.id, name: o.name ?? "" }));
  const next: VaultCache = { revision, syncedAt: Date.now(), ciphers: r.ciphers, folders: r.folders, sends: r.sends ?? [], orgKeys, collections: r.collections ?? [], orgs };
  await setLocal("vault", next);
  await load(next);
  // Forget last-used stamps of items that no longer exist.
  const ids = new Set(r.ciphers.map((c) => (c as { id?: unknown }).id));
  const lastUsed = await getLocal("lastUsed");
  if (lastUsed) await setLocal("lastUsed", Object.fromEntries(Object.entries(lastUsed).filter(([id]) => ids.has(id))));
  return true;
}

/** Makes sure the worker holds the decrypted vault, without moving the whole list around. */
export async function ensureLoaded(): Promise<void> {
  if (await coreCall<boolean>({ op: "vaultLoaded" })) return;
  const cache = await getLocal("vault");
  if (cache) await load(cache);
  else await sync(true);
}

export async function list(): Promise<VaultList> {
  await ensureLoaded();
  const l = await coreCall<VaultList>({ op: "listVault" });
  return { ...l, syncedAt: (await getLocal("vault"))?.syncedAt };
}

export async function save(item: Record<string, unknown>): Promise<VaultList> {
  const account = await getLocal("account");
  if (!account?.userId) throw new UserError("sessionExpired", "Please log in again");
  const enc = await coreCall<Record<string, unknown>>({ op: "prepareSave", item });
  const saved = await saveCipher(await server(), await accessToken(), { ...enc, encryptedFor: account.userId });
  const cache = await getLocal("vault");
  if (cache) {
    const others = cache.ciphers.filter((c) => (c as { id?: unknown }).id !== saved.id);
    await setLocal("vault", { ...cache, ciphers: [...others, saved] });
  }
  await coreCall({ op: "upsertCipher", cipher: saved });
  return list();
}

/** Trash, restore, permanent delete and folder changes re-sync instead of patching the cache by hand. */
async function thenSync(change: (base: string, token: string) => Promise<void>): Promise<VaultList> {
  await change(await server(), await accessToken());
  await sync(true);
  return list();
}

export const trash = (id: string) => thenSync((b, t) => trashCipher(b, t, id));
export const restore = (id: string) => thenSync((b, t) => restoreCipher(b, t, id));
export const purge = (id: string) => thenSync((b, t) => purgeCipher(b, t, id));
export const deleteFolder = (id: string) => thenSync((b, t) => apiDeleteFolder(b, t, id));

export async function saveFolder(name: string, id?: string): Promise<VaultList> {
  // Folder names are encrypted with the user key, like a personal cipher name.
  const enc = await coreCall<{ name: string }>({ op: "prepareSave", item: { type: 2, name } });
  return thenSync((b, t) => apiSaveFolder(b, t, enc.name, id));
}

/** Arms the clipboard clear according to the user's "Clear clipboard" setting (never = cancel). */
export async function scheduleClipboardClear(): Promise<void> {
  const { clearClipboardDelay } = await getSettings();
  const ms = CLEAR_CLIPBOARD_MS[clearClipboardDelay] ?? CLEAR_CLIPBOARD_MS.fiveMinutes;
  if (!ms) return void (await chrome.alarms.clear(CLIPBOARD_ALARM));
  await chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: ms / 60_000 });
}

/** Puts `text` on the clipboard from the offscreen document and arms the clear only if that worked. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const ok = await coreCall<boolean>({ op: "writeClipboard", text });
  // A failed write must not arm the clear: it would wipe whatever the user has on the clipboard.
  if (ok) await scheduleClipboardClear();
  return ok;
}

/** Records a user-gesture fill; page-load autofill prefers the login last used for the site. */
export async function markUsed(id: string): Promise<void> {
  const lastUsed = (await getLocal("lastUsed")) ?? {};
  await setLocal("lastUsed", { ...lastUsed, [id]: Date.now() });
}

/** The full decrypted send (for the edit form). */
export const getSend = (id: string) => coreCall<Record<string, unknown>>({ op: "getSend", id });

export async function clearClipboard(): Promise<void> {
  // Close the document only if this call opened it: an open one may hold a pending 2FA key or an unlock in progress.
  const wasAlive = await coreAlive();
  await coreCall({ op: "writeClipboard", text: "" });
  if (!wasAlive) await chrome.offscreen.closeDocument().catch(() => undefined);
}

// ---------- Import / export ----------

export async function exportVault(password: string): Promise<string> {
  // The whole vault in clear text: ask the server to confirm the master password first, like the official clients.
  await verifyMasterPassword(password);
  await ensureLoaded();
  return coreCall<string>({ op: "exportJson" });
}

export async function importVault(text: string): Promise<{ imported: number; skipped: number }> {
  const account = await getLocal("account");
  if (!account?.userId) throw new UserError("sessionExpired", "Please log in again");
  await ensureLoaded();
  const r = await coreCall<{ ciphers: Record<string, unknown>[]; folders: unknown[]; folderRelationships: unknown[]; skipped: number }>({ op: "prepareImport", text }).catch((e: unknown) => {
    throw new UserError("invalid", (e as Error).message);
  });
  if (!r.ciphers.length) throw new UserError("invalid", "Nothing to import");
  const ciphers = r.ciphers.map((c) => ({ ...c, encryptedFor: account.userId }));
  await importCiphers(await server(), await accessToken(), { ciphers, folders: r.folders, folderRelationships: r.folderRelationships });
  await sync(true);
  return { imported: ciphers.length, skipped: r.skipped };
}

// ---------- Attachments ----------
// Bodies travel base64 through the message hops like Send files (same size cap).

export async function downloadAttachment(cipherId: string, attachmentId: string): Promise<{ fileName: string; data: string }> {
  if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: cipherId }))) throw new UserError("reprompt", REPROMPT_MESSAGE);
  const item = await coreCall<{ attachments?: { id: string; fileName?: string }[] }>({ op: "getCipher", id: cipherId });
  const att = item.attachments?.find((a) => a.id === attachmentId);
  if (!att) throw new UserError("invalid", "Attachment not found");
  const body = await apiDownloadAttachment(await server(), await accessToken(), cipherId, attachmentId);
  return { fileName: att.fileName ?? "attachment", data: await coreCall<string>({ op: "decryptAttachment", cipherId, attachmentId, data: body.toBase64() }) };
}

export async function addAttachment(cipherId: string, file: { name: string; data: string }): Promise<VaultList> {
  if ((file.data.length * 3) / 4 > MAX_SEND_FILE_BYTES) throw new UserError("invalid", "The file is too large (max 25 MB)");
  const enc = await coreCall<{ key: string; fileName: string; data: string }>({ op: "encryptAttachment", cipherId, fileName: file.name, data: file.data });
  return thenSync((b, t) => apiAddAttachment(b, t, cipherId, { key: enc.key, fileName: enc.fileName }, Uint8Array.fromBase64(enc.data)));
}

// ---------- Generator history ----------

const HISTORY_MAX = 100;

export async function generatorHistory(): Promise<HistoryEntry[]> {
  const h = (await getLocal("genHistory")) ?? [];
  const values = await coreCall<string[]>({ op: "decryptText", values: h.map((e) => e.value) });
  return h.map((e, i) => ({ date: e.date, value: values[i] ?? "" }));
}

export async function addGeneratorHistory(value: string): Promise<null> {
  const [enc] = await coreCall<string[]>({ op: "encryptText", values: [value] });
  await setLocal("genHistory", [{ date: Date.now(), value: enc! }, ...((await getLocal("genHistory")) ?? [])].slice(0, HISTORY_MAX));
  return null;
}

export const clearGeneratorHistory = () => removeLocal("genHistory").then(() => null);

// ---------- Send ----------

type Json = Record<string, unknown>;
// shortcut: file content travels base64 through two message hops (64 MiB limit); stream it if bigger files are needed.
export const MAX_SEND_FILE_BYTES = 25 * 1024 * 1024;

export async function sendList(): Promise<SendItem[]> {
  await ensureLoaded(); // the vault and its sends
  const base = await server();
  const entries = await coreCall<(Omit<SendItem, "link"> & { accessId: string; urlKey: string })[]>({ op: "listSends" });
  return entries.map(({ accessId, urlKey, ...e }) => ({ ...e, link: `${base}/#/send/${accessId}/${urlKey}` }));
}

async function cacheSends(update: (sends: unknown[]) => unknown[]): Promise<void> {
  const cache = await getLocal("vault");
  if (cache) await setLocal("vault", { ...cache, sends: update(cache.sends ?? []) });
}

/** Creates a text send, or a file send when `file` is given (content base64); a send with an id is edited. */
export async function saveSend(send: Json, file?: { name: string; data: string }): Promise<SendItem[]> {
  const base = await server();
  const token = await accessToken();
  let saved: Json;
  if (typeof send.id === "string") {
    saved = await updateSend(base, token, send.id, await coreCall<Json>({ op: "prepareSend", send }));
    await cacheSends((s) => s.map((x) => ((x as Json).id === saved.id ? saved : x)));
    await coreCall({ op: "upsertSend", send: saved });
    return sendList();
  }
  if (file) {
    if ((file.data.length * 3) / 4 > MAX_SEND_FILE_BYTES) throw new UserError("invalid", "The file is too large (max 25 MB)");
    const enc = await coreCall<Json>({ op: "prepareSend", send: { ...send, type: 1, text: undefined, file: { fileName: file.name } } });
    const body = Uint8Array.fromBase64(await coreCall<string>({ op: "encryptSendFile", key: String(enc.key), data: file.data }));
    saved = await createFileSend(base, token, { ...enc, fileLength: body.length });
    const f = saved.file as Json | undefined;
    // Without its file the send is useless to a recipient: remove it again if the upload fails.
    await uploadSendFile(base, token, String(saved.id), String(f?.id), String(f?.fileName), body).catch(async (e: unknown) => {
      await apiDeleteSend(base, token, String(saved.id)).catch(() => undefined);
      throw e;
    });
  } else {
    saved = await createSend(base, token, await coreCall<Json>({ op: "prepareSend", send: { ...send, type: 0 } }));
  }
  await cacheSends((s) => [...s, saved]);
  await coreCall({ op: "upsertSend", send: saved });
  return sendList();
}

/** Removes the access password in place; the link and the content stay the same. */
export async function removeSendPassword(id: string): Promise<SendItem[]> {
  const base = await server();
  const token = await accessToken();
  const saved = await apiRemoveSendPassword(base, token, id);
  await cacheSends((s) => s.map((x) => ((x as Json).id === saved.id ? saved : x)));
  await coreCall({ op: "upsertSend", send: saved });
  return sendList();
}

export async function deleteSend(id: string): Promise<SendItem[]> {
  await apiDeleteSend(await server(), await accessToken(), id);
  await cacheSends((s) => s.filter((x) => (x as { id?: unknown }).id !== id));
  await coreCall({ op: "removeSend", id });
  return sendList();
}
