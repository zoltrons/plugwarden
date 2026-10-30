// Forwarded email aliases: the one place that talks to a forwarding service.
//
// Nothing here touches the vault: an alias is created from the user's API token and the page they are
// on. Tokens live in storage.session (see store.ts), the request shapes in shared/alias.ts. A request
// only ever leaves after an explicit click in the generator.
import {
  ALIAS_INFO,
  type AliasContext,
  AliasError,
  aliasAccountId,
  aliasAccountRequest,
  aliasCreateRequest,
  aliasBaseUrl,
  aliasGeneratedBy,
  aliasResult,
  defaultAliasSettings,
  normalizeAliasBaseUrl,
  type AliasSettings,
  type AliasVendor,
} from "../shared/alias.ts";
import { readBytes } from "../transport/http.ts";
import { ci } from "../shared/validate.ts";
import { UserError } from "./account.ts";
import { getSession, updateSession } from "./store.ts";

/** An alias is a small JSON body; a broken or hostile service must not fill the worker's memory. */
const MAX_ALIAS_BYTES = 64 * 1024;
const ALIAS_TIMEOUT_MS = 15_000;

const msg = (key: string, ...subs: string[]): string => chrome.i18n.getMessage(key, subs) || key;

/** Settings for one service, with defaults filled in. */
export async function getAliasSettings(vendor: AliasVendor): Promise<AliasSettings> {
  const saved = (await getSession()).alias?.[vendor];
  return saved ? { ...defaultAliasSettings(vendor), ...saved, vendor } : defaultAliasSettings(vendor);
}

export async function saveAliasSettings(settings: AliasSettings): Promise<void> {
  const info = ALIAS_INFO[settings.vendor];
  if (info.selfHost && settings.baseUrl.trim()) {
    // Reject a bad URL while the user is on the field, not when the first alias fails.
    try {
      normalizeAliasBaseUrl(settings.baseUrl);
    } catch (e) {
      throw new UserError("invalid", (e as Error).message);
    }
  }
  const current = (await getSession()).alias ?? {};
  await updateSession({ alias: { ...current, [settings.vendor]: settings } });
}

/** The page the alias is being made for: the active tab, never a URL from the message. Query and fragment stay home (reset tokens, session ids). */
async function activeWebsite(): Promise<string> {
  const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  try {
    const url = new URL(tab?.url ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin + url.pathname : "";
  } catch {
    return "";
  }
}

/** First readable message out of a service's error body (JSON or plain text). */
function serviceMessage(body: unknown, status: number): string {
  const nested = ci(ci(body, "error"), "message");
  const found = [ci(body, "error_description"), ci(body, "message"), nested, ci(ci(body, "error"), "description")].find(
    (m): m is string => typeof m === "string" && m.trim() !== "",
  );
  if (found) return found.trim();
  const error = ci(body, "error");
  if (typeof error === "string" && error.trim() && !error.includes("<")) return error.trim();
  // A service answering with an HTML error page has nothing useful for us in it.
  if (typeof body === "string" && body.trim() && !body.includes("<")) return body.trim().slice(0, 200);
  return `HTTP ${status}`;
}

async function call(vendor: AliasVendor, request: ReturnType<typeof aliasCreateRequest>): Promise<unknown> {
  const name = ALIAS_INFO[vendor].name;
  let res: Response;
  try {
    res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(ALIAS_TIMEOUT_MS),
    });
  } catch {
    throw new UserError("network", msg("aliasUnreachable", name));
  }
  let text: string;
  try {
    text = new TextDecoder().decode(await readBytes(res, MAX_ALIAS_BYTES));
  } catch {
    throw new UserError("alias", msg("aliasBadResponse", name));
  }
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (res.status === 401) throw new UserError("alias", msg("aliasInvalidToken", name));
  if (res.status === 403) throw new UserError("alias", msg("aliasRefused", name, serviceMessage(body, res.status)));
  if (!res.ok) throw new UserError("alias", msg("aliasHttpError", name, serviceMessage(body, res.status)));
  return body;
}

/** Asks the configured service for a new alias for the active tab. Returns the address. */
export async function generateAlias(vendor: AliasVendor): Promise<string> {
  const settings = await getAliasSettings(vendor);
  const name = ALIAS_INFO[vendor].name;

  const website = await activeWebsite();
  const ctx: AliasContext = {
    website,
    // Upstream's "generatedBy": the full URL for services that store a free-form note, the host for
    // those that store a short description. Each builder passes the one it uses.
    generatedBy: (target) => aliasGeneratedBy(target, msg("aliasGeneratedBy"), (t) => msg("aliasGeneratedByWithWebsite", t)),
  };

  try {
    // Fail on a malformed/unsafe base URL before any request leaves.
    aliasBaseUrl(settings);
    const accountRequest = aliasAccountRequest(settings);
    const accountId = accountRequest ? aliasAccountId(await call(vendor, accountRequest)) : "";
    return aliasResult(settings, await call(vendor, aliasCreateRequest(settings, ctx, accountId)));
  } catch (e) {
    if (!(e instanceof AliasError)) throw e;
    throw new UserError("alias", aliasErrorText(name, e));
  }
}

function aliasErrorText(name: string, e: AliasError): string {
  switch (e.code) {
    case "noToken":
      return msg("aliasNoToken", name);
    case "noDomain":
      return msg("aliasNoDomain", name);
    case "noAccount":
      return msg("aliasNoAccount", name);
    case "service":
      return msg("aliasRefused", name, e.message);
    case "badBaseUrl":
      return e.message;
    default:
      return msg("aliasBadResponse", name);
  }
}
