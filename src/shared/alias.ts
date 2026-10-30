// Forwarded email aliases: request shaping for the services the official clients support
// (clients libs/tools/generator/core/src/integration/{simple-login,addy-io,duck-duck-go,fastmail,
// firefox-relay,forward-email}.ts, pinned in upstream.lock).
//
// Pure functions only: no network, no storage. The fetch lives in background/alias.ts, the UI in
// ui/vault.ts; both go through these builders so what we send matches upstream exactly.
import { isLoopback } from "./url.ts";

export const ALIAS_VENDORS = ["simplelogin", "addyio", "duckduckgo", "fastmail", "firefox", "forwardemail"] as const;
export type AliasVendor = (typeof ALIAS_VENDORS)[number];

/** Settings a vendor's request actually reads. */
export type AliasField = "token" | "baseUrl" | "domain" | "prefix";

export interface AliasSettings {
  vendor: AliasVendor;
  /** API key / token issued by the service. Lives in storage.session, never on disk. */
  token: string;
  /** Self-hosted API base URL; empty means the service's public API. */
  baseUrl: string;
  /** Email domain, for services that create aliases on a domain you own. */
  domain: string;
  /** Fastmail only: put the website's domain in front of the generated address. */
  prefix: boolean;
}

export interface AliasVendorInfo {
  name: string;
  /** Public API base; upstream `baseUrl` in the integration definition. */
  baseUrl: string;
  /** Self-hosting allowed (`selfHost: "maybe"`); the base URL field is shown. */
  selfHost: boolean;
  fields: readonly AliasField[];
  /** Generation is refused while one of these is empty. */
  required: readonly Exclude<AliasField, "prefix">[];
  /**
   * Where the user gets a token. The browser extension links to these from the generator.
   * Empty when the service has no public documentation page for it.
   */
  help?: string;
}

export const ALIAS_INFO: Record<AliasVendor, AliasVendorInfo> = {
  simplelogin: {
    name: "SimpleLogin",
    baseUrl: "https://app.simplelogin.io",
    selfHost: true,
    fields: ["token", "baseUrl"],
    required: ["token"],
    help: "https://app.simplelogin.io/dashboard/api_key",
  },
  addyio: {
    name: "Addy.io",
    baseUrl: "https://app.addy.io",
    selfHost: true,
    // Upstream also shows a domain field for SimpleLogin, but no request uses it.
    fields: ["token", "baseUrl", "domain"],
    required: ["token", "domain"],
    help: "https://app.addy.io/settings/account",
  },
  duckduckgo: {
    name: "DuckDuckGo",
    // Tokens come from DuckDuckGo's own auth flow (the desktop app's “Generate alias” feature).
    baseUrl: "https://quack.duckduckgo.com/api",
    selfHost: false,
    fields: ["token"],
    required: ["token"],
  },
  fastmail: {
    name: "Fastmail",
    baseUrl: "https://api.fastmail.com",
    selfHost: false,
    fields: ["token", "prefix"],
    required: ["token"],
    help: "https://app.fastmail.com/settings/security/api",
  },
  firefox: {
    name: "Firefox Relay",
    baseUrl: "https://relay.firefox.com/api",
    selfHost: false,
    fields: ["token"],
    required: ["token"],
    help: "https://relay.firefox.com/accounts/profile/",
  },
  forwardemail: {
    name: "Forward Email",
    baseUrl: "https://api.forwardemail.net",
    selfHost: false,
    fields: ["token", "domain"],
    required: ["token", "domain"],
    help: "https://forwardemail.net/my-account/security",
  },
};

export type AliasErrorCode = "noToken" | "noDomain" | "badBaseUrl" | "noAccount" | "badResponse" | "service";

export class AliasError extends Error {
  override name = "AliasError";
  readonly code: AliasErrorCode;
  /** `message` only matters for codes the worker cannot word itself (`badBaseUrl`, `service`). */
  constructor(code: AliasErrorCode, message = "") {
    super(message);
    this.code = code;
  }
}

export const defaultAliasSettings = (vendor: AliasVendor): AliasSettings => ({ vendor, token: "", baseUrl: "", domain: "", prefix: false });

/** Missing settings that would make generation fail; empty when the vendor is configured. */
export function missingAliasFields(settings: AliasSettings): AliasField[] {
  return ALIAS_INFO[settings.vendor].required.filter((f) => !settings[f].trim());
}

/** Normalizes a user-entered API base URL: https only, except loopback (like the vault server). */
export function normalizeAliasBaseUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new AliasError("badBaseUrl", "Enter a valid URL");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname)))
    throw new AliasError("badBaseUrl", "API URL must use https (plain http only for localhost)");
  if (u.username || u.password || u.search || u.hash)
    throw new AliasError("badBaseUrl", "API URL must not contain credentials, a query or a fragment");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** The API base URL in use: the user's self-host URL when the service allows it, else the public API. */
export function aliasBaseUrl(settings: AliasSettings): string {
  const info = ALIAS_INFO[settings.vendor];
  const custom = settings.baseUrl.trim();
  return normalizeAliasBaseUrl(info.selfHost && custom ? custom : info.baseUrl);
}

/** Host of the page the user is on (`` when the popup has no web page). */
export function aliasHost(website: string): string {
  try {
    return new URL(website).hostname;
  } catch {
    return "";
  }
}

/**
 * Fastmail's "website prefix": `example.com` → `example`, `foo.bar.example.com` → `foo_bar_example`.
 * Upstream consults the public suffix list, so `example.co.uk` comes out as `example` there and as
 * `example_co` here. The prefix is cosmetic; it never decides which address is created.
 */
export function websitePrefix(host: string): string {
  if (!host) return "";
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host.replace(/[.:]/g, "_"); // IPv4 / IPv6
  const parts = host.split(".").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("_") : parts.join("");
}

/** What the integration knows about the page and how to describe us in the service's UI. */
export interface AliasContext {
  /** Full URL of the current website, `` when unknown. */
  website: string;
  /** Localized "Website: <target>. Generated by Plugwarden." (or the version without a website). */
  generatedBy: (target: string) => string;
}

/**
 * The "generated by" note a service stores with the address. `target` is the host or the full URL,
 * whichever that service's request uses, and it is passed through unchanged (re-parsing a bare host
 * would drop it). `plain` is used when the popup is not on a web page.
 */
export function aliasGeneratedBy(target: string, plain: string, withWebsite: (target: string) => string): string {
  return target ? withWebsite(target) : plain;
}

export interface AliasRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** JSON body; absent when the service takes none. */
  body?: string;
}

const base64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

function token(settings: AliasSettings): string {
  const token = settings.token.trim();
  if (!token) throw new AliasError("noToken");
  return token;
}

function domain(settings: AliasSettings): string {
  const d = settings.domain.trim().replace(/^@/, "");
  if (!d) throw new AliasError("noDomain");
  return d;
}

/** Auth header per vendor, exactly as the integration defines it (`authenticate`). */
function authHeaders(settings: AliasSettings): Record<string, string> {
  switch (settings.vendor) {
    // SimpleLogin takes its key in a header named "Authentication", with no scheme prefix.
    case "simplelogin":
      return { Authentication: token(settings) };
    case "firefox":
      return { Authorization: `Token ${token(settings)}` };
    // Forward Email: HTTP basic with the API key as the user name and an empty password.
    case "forwardemail":
      return { Authorization: `Basic ${base64(`${token(settings)}:`)}` };
    default:
      return { Authorization: `Bearer ${token(settings)}` };
  }
}

const jsonHeaders = { Accept: "application/json", "Content-Type": "application/json" };

/**
 * Fastmail keeps aliases under a JMAP account id that has to be looked up first. The other services
 * create an alias in one call, so this returns undefined for them.
 */
export function aliasAccountRequest(settings: AliasSettings): AliasRequest | undefined {
  if (settings.vendor !== "fastmail") return undefined;
  return {
    method: "GET",
    url: `${aliasBaseUrl(settings)}/jmap/session`,
    headers: { ...authHeaders(settings), Accept: "application/json" },
  };
}

export function aliasAccountId(json: unknown): string {
  const primary = (json as { primaryAccounts?: Record<string, string> } | null)?.primaryAccounts;
  const id = primary?.["https://www.fastmail.com/dev/maskedemail"];
  if (!id) throw new AliasError("noAccount");
  return id;
}

/** The request that creates the alias. `accountId` is only used by Fastmail. */
export function aliasCreateRequest(settings: AliasSettings, ctx: AliasContext, accountId = ""): AliasRequest {
  const base = aliasBaseUrl(settings);
  const host = aliasHost(ctx.website);
  const headers = { ...jsonHeaders, ...authHeaders(settings) };
  switch (settings.vendor) {
    case "simplelogin": {
      const endpoint = `${base}/api/alias/random/new`;
      return {
        method: "POST",
        url: host ? `${endpoint}?hostname=${encodeURIComponent(host)}` : endpoint,
        headers,
        body: JSON.stringify({ note: ctx.generatedBy(ctx.website) }),
      };
    }
    case "addyio":
      return {
        method: "POST",
        url: `${base}/api/v1/aliases`,
        headers,
        body: JSON.stringify({ domain: domain(settings), description: ctx.generatedBy(host).slice(0, 200) }),
      };
    case "duckduckgo":
      return { method: "POST", url: `${base}/email/addresses`, headers };
    case "fastmail":
      return {
        method: "POST",
        url: `${base}/jmap/api/`,
        headers,
        body: JSON.stringify({
          using: ["https://www.fastmail.com/dev/maskedemail", "urn:ietf:params:jmap:core"],
          methodCalls: [
            [
              "MaskedEmail/set",
              {
                accountId,
                create: {
                  "new-masked-email": {
                    state: "enabled",
                    description: "",
                    forDomain: ctx.website,
                    emailPrefix: settings.prefix ? websitePrefix(host) : "",
                  },
                },
              },
              "0",
            ],
          ],
        }),
      };
    case "firefox":
      return {
        method: "POST",
        url: `${base}/v1/relayaddresses/`,
        headers,
        body: JSON.stringify({
          enabled: true,
          generated_for: ctx.website.slice(0, 255),
          description: ctx.generatedBy(host).slice(0, 64),
        }),
      };
    case "forwardemail":
      return {
        method: "POST",
        url: `${base}/v1/domains/${encodeURIComponent(domain(settings))}/aliases`,
        headers,
        body: JSON.stringify({ labels: ctx.website, description: ctx.generatedBy(ctx.website) }),
      };
  }
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The generated address out of the service's response; throws when it did not return one. */
export function aliasResult(settings: AliasSettings, json: unknown): string {
  const body = (json ?? {}) as Record<string, unknown>;
  const bad = (detail?: string) => new AliasError(detail ? "service" : "badResponse", detail);
  switch (settings.vendor) {
    case "simplelogin": {
      const alias = text(body.alias);
      if (!alias) throw bad();
      return alias;
    }
    case "addyio": {
      const alias = text((body.data as Record<string, unknown> | undefined)?.email);
      if (!alias) throw bad();
      return alias;
    }
    case "duckduckgo": {
      const address = text(body.address);
      if (!address) throw bad();
      return `${address}@duck.com`;
    }
    case "fastmail": {
      const responses = body.methodResponses;
      const first = Array.isArray(responses) && Array.isArray(responses[0]) ? (responses[0] as unknown[]) : undefined;
      const name = text(first?.[0]);
      const result = (first?.[1] ?? {}) as Record<string, unknown>;
      if (name === "MaskedEmail/set") {
        const created = (result.created as Record<string, Record<string, unknown>> | undefined)?.["new-masked-email"];
        const email = text(created?.email);
        if (email) return email;
        const denied = (result.notCreated as Record<string, Record<string, unknown>> | undefined)?.["new-masked-email"];
        if (denied) throw bad(text(denied.description) || undefined);
      }
      // JMAP reports a failed call as ["error", { type, description }].
      if (name === "error") throw bad(text(result.description) || text(result.type) || undefined);
      throw bad();
    }
    case "firefox": {
      const alias = text(body.full_address);
      if (!alias) throw bad();
      return alias;
    }
    case "forwardemail": {
      const name = text(body.name);
      if (!name) throw bad();
      const created = text((body.domain as Record<string, unknown> | undefined)?.name);
      return `${name}@${created || domain(settings)}`;
    }
  }
}
