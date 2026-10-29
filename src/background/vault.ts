// Vault orchestration in the service worker: encrypted cache in storage.local, sync, and writes.
// Decryption happens in the offscreen worker; the SW only moves encrypted JSON around.
import type { SendItem, VaultList } from "../shared/messages.ts";
import { revisionDate } from "../transport/auth.ts";
import {
  createFileSend,
  createSend,
  deleteFolder as apiDeleteFolder,
  deleteSend as apiDeleteSend,
  fullSync,
  purgeCipher,
  restoreCipher,
  saveCipher,
  saveFolder as apiSaveFolder,
  trashCipher,
  uploadSendFile,
} from "../transport/vault.ts";
import { accessToken, UserError } from "./account.ts";
import { coreAlive, coreCall } from "./core.ts";
import { getLocal, getSession, setLocal, type VaultCache } from "./store.ts";

export const CLIPBOARD_ALARM = "clipboard";

export async function requireUnlocked(): Promise<void> {
  if (!(await getSession()).unlocked || !(await coreAlive())) throw new UserError("wrongPhase", "The vault is locked");
}

async function server(): Promise<string> {
  const s = await getLocal("server");
  if (!s) throw new UserError("wrongPhase", "No server configured");
  return s.url;
}

const load = (c: VaultCache) => coreCall({ op: "loadVault", ciphers: c.ciphers, folders: c.folders, sends: c.sends ?? [], orgKeys: c.orgKeys });

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
  const next: VaultCache = { revision, syncedAt: Date.now(), ciphers: r.ciphers, folders: r.folders, sends: r.sends ?? [], orgKeys };
  await setLocal("vault", next);
  await load(next);
  return true;
}

export async function list(): Promise<VaultList> {
  let l = await coreCall<VaultList | null>({ op: "listVault" });
  if (!l) {
    const cache = await getLocal("vault");
    if (cache) await load(cache);
    else await sync(true);
    l = await coreCall<VaultList>({ op: "listVault" });
  }
  return { ...l!, syncedAt: (await getLocal("vault"))?.syncedAt };
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

/** Clears the clipboard; closes the offscreen document again if it only exists for this. */
export async function clearClipboard(): Promise<void> {
  const unlocked = (await getSession()).unlocked;
  await coreCall({ op: "clearClipboard" });
  if (!unlocked) await chrome.offscreen.closeDocument().catch(() => undefined);
}

// ---------- Send ----------

type Json = Record<string, unknown>;
// shortcut: file content travels base64 through two message hops (64 MiB limit); stream it if bigger files are needed.
export const MAX_SEND_FILE_BYTES = 25 * 1024 * 1024;

export async function sendList(): Promise<SendItem[]> {
  await list(); // loads the vault (and its sends) into the worker if needed
  const base = await server();
  const entries = await coreCall<(Omit<SendItem, "link"> & { accessId: string; urlKey: string })[]>({ op: "listSends" });
  return entries.map(({ accessId, urlKey, ...e }) => ({ ...e, link: `${base}/#/send/${accessId}/${urlKey}` }));
}

async function cacheSends(update: (sends: unknown[]) => unknown[]): Promise<void> {
  const cache = await getLocal("vault");
  if (cache) await setLocal("vault", { ...cache, sends: update(cache.sends ?? []) });
}

/** Creates a text send, or a file send when `file` is given (content base64). */
export async function saveSend(send: Json, file?: { name: string; data: string }): Promise<SendItem[]> {
  const base = await server();
  const token = await accessToken();
  let saved: Json;
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

export async function deleteSend(id: string): Promise<SendItem[]> {
  await apiDeleteSend(await server(), await accessToken(), id);
  await cacheSends((s) => s.filter((x) => (x as { id?: unknown }).id !== id));
  await coreCall({ op: "removeSend", id });
  return sendList();
}
