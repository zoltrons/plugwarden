// URI matching with Bitwarden's UriMatchType semantics (clients: libs/common/src/models/domain/login-uri).
// A null `match` means "Default": the account's default URI match strategy (Domain unless changed).
import { URI_MATCH as MATCH } from "../shared/constants.ts";
export { MATCH };

/** Public Suffix List lookup (rules as in public_suffix_list.dat, punycode). */
export class Psl {
  private readonly rules: Set<string>;
  constructor(rules: Iterable<string>) {
    this.rules = new Set(rules);
  }

  /** True for "com", "co.uk", "github.io": nobody owns them, so nothing may be scoped to them. */
  isPublicSuffix(domain: string): boolean {
    return this.baseDomain(`x.${domain}`) === `x.${domain}`;
  }

  /** Registrable domain ("eTLD+1"); IPs, single labels and public suffixes themselves map to the host. */
  baseDomain(host: string): string {
    const h = host.toLowerCase().replace(/\.$/, "");
    if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return h;
    const labels = h.split(".");
    let suffixLen = 1; // implicit "*" rule
    for (let i = 0; i < labels.length; i++) {
      const cand = labels.slice(i).join(".");
      if (this.rules.has(`!${cand}`)) {
        suffixLen = labels.length - i - 1;
        break;
      }
      if (this.rules.has(cand) || (i + 1 < labels.length && this.rules.has(`*.${labels.slice(i + 1).join(".")}`))) {
        suffixLen = labels.length - i;
        break;
      }
    }
    return labels.length > suffixLen ? labels.slice(labels.length - suffixLen - 1).join(".") : h;
  }
}

/** Saved URIs may lack a scheme ("example.com"); Bitwarden treats those as http(s). */
export function parseUri(uri: string): URL | undefined {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `http://${uri}`);
  } catch {
    return undefined;
  }
}

export function uriMatches(saved: string, match: number | null | undefined, page: URL, psl: Psl, defaultMatch: number = MATCH.Domain): boolean {
  if (page.protocol !== "https:" && page.protocol !== "http:") return false;
  switch (match ?? defaultMatch) {
    case MATCH.Domain: {
      const s = parseUri(saved);
      if (!s?.hostname) return false;
      return s.hostname === page.hostname || psl.baseDomain(s.hostname) === psl.baseDomain(page.hostname);
    }
    case MATCH.Host:
      return parseUri(saved)?.host === page.host;
    case MATCH.StartsWith:
      return page.href.startsWith(saved);
    case MATCH.Exact:
      return page.href === saved;
    case MATCH.RegularExpression:
      try {
        return new RegExp(saved, "i").test(page.href);
      } catch {
        return false;
      }
    default: // Never, unknown
      return false;
  }
}
