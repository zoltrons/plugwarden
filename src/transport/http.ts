// Thin fetch wrapper with the Bitwarden client headers. Runs in the service worker only.
import { CLIENT_NAME, CLIENT_VERSION, DEVICE_TYPE } from "../shared/constants.ts";
import { ci } from "../shared/validate.ts";

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends Error {
  override name = "NetworkError";
}

export interface CallOptions {
  json?: unknown;
  form?: Record<string, string>;
  /** multipart/form-data (file uploads); the browser sets the boundary header. */
  data?: FormData;
  token?: string;
  signal?: AbortSignal;
}

/**
 * Upper bound for a response body. A broken or hostile server must not be able to exhaust the service
 * worker's memory (or the worker's message budget) by answering with an endless stream. Generous: the
 * local vault cache is limited to chrome.storage's 10 MB anyway.
 */
export const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

const tooLarge = (what: string) => new ApiError(0, null, `The server's ${what} is too large`);

/** Streams a body into memory, refusing anything over `max` bytes. */
export async function readBytes(res: Response, max = MAX_RESPONSE_BYTES, what = "response"): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooLarge(what);
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(what);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** First non-empty message. Vaultwarden's generic error sends `error_description: ""` next to the real `message`. */
export function errorMessage(body: unknown, status: number): string {
  const candidates = [
    ci(body, "error_description"),
    ci(ci(body, "ErrorModel"), "Message"),
    ci(body, "message"),
    ci(ci(body, "error"), "description"),
  ];
  return candidates.find((m): m is string => typeof m === "string" && m.trim() !== "") ?? `HTTP ${status}`;
}

export async function call(base: string, method: string, path: string, opts: CallOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Bitwarden-Client-Name": CLIENT_NAME,
    "Bitwarden-Client-Version": CLIENT_VERSION,
    "Device-Type": String(DEVICE_TYPE),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
    body = new URLSearchParams(opts.form);
  } else if (opts.data) body = opts.data;
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  const bytes = await readBytes(res);
  const text = bytes.byteLength ? new TextDecoder().decode(bytes) : "";
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body (e.g. revision-date as plain number is still JSON) */
    }
  } else data = null;
  if (!res.ok) throw new ApiError(res.status, data, errorMessage(data, res.status));
  return data;
}
