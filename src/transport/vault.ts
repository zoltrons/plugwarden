// Vault endpoints (mirrors vaultwarden src/api/core/ciphers.rs, see upstream-map.yaml).
import { arr, obj, opt, parse, record, str, unknownValue } from "../shared/validate.ts";
import { ApiError, call, NetworkError, readBytes } from "./http.ts";

const syncResponse = obj({
  ciphers: arr(unknownValue),
  folders: arr(unknownValue),
  sends: opt(arr(unknownValue)),
  collections: opt(arr(unknownValue)),
  profile: obj({ organizations: opt(arr(obj({ id: str, key: opt(str), name: opt(str) }))) }),
});
export type SyncResponse = ReturnType<typeof syncResponse>;

export async function fullSync(base: string, token: string): Promise<SyncResponse> {
  return parse(syncResponse, await call(base, "GET", "/api/sync?excludeDomains=true", { token }));
}

/** `cipher` is the encrypted CipherData; Vaultwarden requires `encryptedFor` (the user id). */
export async function saveCipher(base: string, token: string, cipher: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = typeof cipher.id === "string" && cipher.id ? cipher.id : undefined;
  const path = id ? `/api/ciphers/${encodeURIComponent(id)}` : "/api/ciphers";
  return parse(record, await call(base, id ? "PUT" : "POST", path, { token, json: cipher }));
}

export async function restoreCipher(base: string, token: string, id: string): Promise<void> {
  await call(base, "PUT", `/api/ciphers/${encodeURIComponent(id)}/restore`, { token });
}

/** Permanent delete (from the trash). */
export async function purgeCipher(base: string, token: string, id: string): Promise<void> {
  await call(base, "DELETE", `/api/ciphers/${encodeURIComponent(id)}`, { token });
}

/** `name` is the encrypted folder name. */
export async function saveFolder(base: string, token: string, name: string, id?: string): Promise<void> {
  await call(base, id ? "PUT" : "POST", id ? `/api/folders/${encodeURIComponent(id)}` : "/api/folders", { token, json: { name } });
}

export async function deleteFolder(base: string, token: string, id: string): Promise<void> {
  await call(base, "DELETE", `/api/folders/${encodeURIComponent(id)}`, { token });
}

/** Moves the item to the trash (restorable from the web vault). */
export async function trashCipher(base: string, token: string, id: string): Promise<void> {
  await call(base, "PUT", `/api/ciphers/${encodeURIComponent(id)}/delete`, { token });
}

export async function importCiphers(base: string, token: string, data: { ciphers: unknown[]; folders: unknown[]; folderRelationships: unknown[] }): Promise<void> {
  await call(base, "POST", "/api/ciphers/import", { token, json: data });
}

/** Re-checks the master password (400 when wrong). */
export async function verifyPassword(base: string, token: string, masterPasswordHash: string): Promise<void> {
  await call(base, "POST", "/api/accounts/verify-password", { token, json: { masterPasswordHash } });
}

// ---------- Attachments (vaultwarden src/api/core/ciphers.rs) ----------

const path = (cipherId: string, attachmentId?: string) =>
  `/api/ciphers/${encodeURIComponent(cipherId)}/attachment${attachmentId ? `/${encodeURIComponent(attachmentId)}` : ""}`;

/** An encrypted attachment for a 25 MB file, with the EncArrayBuffer framing: 40 MB is ample. */
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

/** The encrypted body, through the signed download URL the server hands out. */
export async function downloadAttachment(base: string, token: string, cipherId: string, attachmentId: string): Promise<Uint8Array> {
  const { url } = parse(obj({ url: str }), await call(base, "GET", path(cipherId, attachmentId), { token }));
  // The URL is server-supplied and the extension holds host permissions for every origin, so it must
  // stay on the configured server: Vaultwarden builds it from its own domain, so no cross-origin (or
  // metadata-endpoint) target is ever legitimate here. Redirects are refused too: one could leave the
  // server. (An attachment store that answers with a redirect, e.g. S3, therefore cannot be downloaded.)
  let target: URL;
  try {
    target = new URL(url, base);
  } catch {
    throw new ApiError(0, null, "The server returned an invalid attachment URL");
  }
  if (target.origin !== new URL(base).origin) throw new ApiError(0, null, "The server returned an attachment URL that is not on this server");
  let res: Response;
  try {
    res = await fetch(target, { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new ApiError(res.status, null, `Attachment download failed (${res.status})`);
  return readBytes(res, MAX_ATTACHMENT_BYTES, "attachment");
}

/** Registers a new attachment (encrypted key and name) and uploads its encrypted body. */
export async function addAttachment(base: string, token: string, cipherId: string, meta: { key: string; fileName: string }, body: Uint8Array): Promise<void> {
  const { attachmentId } = parse(obj({ attachmentId: str }), await call(base, "POST", `${path(cipherId)}/v2`, { token, json: { ...meta, fileSize: body.length } }));
  const data = new FormData();
  data.append("data", new Blob([body as Uint8Array<ArrayBuffer>]), meta.fileName);
  // Without its body the attachment is broken: remove it again if the upload fails.
  await call(base, "POST", path(cipherId, attachmentId), { token, data }).catch(async (e: unknown) => {
    await call(base, "DELETE", path(cipherId, attachmentId), { token }).catch(() => undefined);
    throw e;
  });
}

// ---------- Send (vaultwarden src/api/core/sends.rs) ----------

export async function createSend(base: string, token: string, send: Record<string, unknown>): Promise<Record<string, unknown>> {
  return parse(record, await call(base, "POST", "/api/sends", { token, json: send }));
}

const fileSendResponse = obj({ sendResponse: record });

/** Creates a file send; the encrypted body is uploaded separately with uploadSendFile. */
export async function createFileSend(base: string, token: string, send: Record<string, unknown>): Promise<Record<string, unknown>> {
  return parse(fileSendResponse, await call(base, "POST", "/api/sends/file/v2", { token, json: send })).sendResponse;
}

/** `fileName` must be the encrypted name the server stored for the send. */
export async function uploadSendFile(base: string, token: string, sendId: string, fileId: string, fileName: string, body: Uint8Array): Promise<void> {
  const data = new FormData();
  data.append("data", new Blob([body as Uint8Array<ArrayBuffer>]), fileName);
  await call(base, "POST", `/api/sends/${encodeURIComponent(sendId)}/file/${encodeURIComponent(fileId)}`, { token, data });
}

export async function updateSend(base: string, token: string, id: string, send: Record<string, unknown>): Promise<Record<string, unknown>> {
  return parse(record, await call(base, "PUT", `/api/sends/${encodeURIComponent(id)}`, { token, json: send }));
}

export async function deleteSend(base: string, token: string, id: string): Promise<void> {
  await call(base, "DELETE", `/api/sends/${encodeURIComponent(id)}`, { token });
}

/** Clears the send's access password (vaultwarden src/api/core/sends.rs, put_remove_password). */
export async function removeSendPassword(base: string, token: string, id: string): Promise<Record<string, unknown>> {
  return parse(record, await call(base, "PUT", `/api/sends/${encodeURIComponent(id)}/remove-password`, { token }));
}
