// Vault orchestration in the service worker: encrypted cache in storage.local, sync, and writes.
// Decryption happens in the offscreen worker; the SW only moves encrypted JSON around.
import type { VaultList } from "../shared/messages.ts";
import { revisionDate } from "../transport/auth.ts";
import { fullSync, saveCipher, trashCipher } from "../transport/vault.ts";
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

const load = (c: VaultCache) => coreCall({ op: "loadVault", ciphers: c.ciphers, folders: c.folders, orgKeys: c.orgKeys });

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
  const next: VaultCache = { revision, syncedAt: Date.now(), ciphers: r.ciphers, folders: r.folders, orgKeys };
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

export async function trash(id: string): Promise<VaultList> {
  await trashCipher(await server(), await accessToken(), id);
  const cache = await getLocal("vault");
  if (cache) await setLocal("vault", { ...cache, ciphers: cache.ciphers.filter((c) => (c as { id?: unknown }).id !== id) });
  await coreCall({ op: "removeCipher", id });
  return list();
}

/** Clears the clipboard; closes the offscreen document again if it only exists for this. */
export async function clearClipboard(): Promise<void> {
  const unlocked = (await getSession()).unlocked;
  await coreCall({ op: "clearClipboard" });
  if (!unlocked) await chrome.offscreen.closeDocument().catch(() => undefined);
}
