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
  token?: string;
  signal?: AbortSignal;
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
  }
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
  const text = await res.text();
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
