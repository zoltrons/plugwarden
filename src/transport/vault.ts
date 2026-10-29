// Vault endpoints (mirrors vaultwarden src/api/core/ciphers.rs, see upstream-map.yaml).
import { arr, obj, opt, parse, record, str, unknownValue } from "../shared/validate.ts";
import { call } from "./http.ts";

const syncResponse = obj({
  ciphers: arr(unknownValue),
  folders: arr(unknownValue),
  sends: opt(arr(unknownValue)),
  profile: obj({ organizations: opt(arr(obj({ id: str, key: opt(str) }))) }),
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

/** Moves the item to the trash (restorable from the web vault). */
export async function trashCipher(base: string, token: string, id: string): Promise<void> {
  await call(base, "PUT", `/api/ciphers/${encodeURIComponent(id)}/delete`, { token });
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

export async function deleteSend(base: string, token: string, id: string): Promise<void> {
  await call(base, "DELETE", `/api/sends/${encodeURIComponent(id)}`, { token });
}
