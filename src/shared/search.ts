// Vault search language: words, "quoted phrases", -exclusions and `qualifier:value` (title, username, url, ...).
// Only the qualifiers below are special, so a query like `https://github` is still plain text.

const FIELDS = ["title", "name", "username", "email", "url", "domain", "host", "folder", "type", "is"] as const;
type Field = (typeof FIELDS)[number];

export interface Clause {
  not: boolean;
  field?: Field;
  value: string;
}

/** What a clause can look at. Everything is already lower-case-insensitive text from the list summary. */
export interface Searchable {
  name: string;
  sub: string;
  uris: string[];
  folder: string;
  /** Names the type answers to (localised and English). */
  type: string[];
  flags: string[];
}

const TOKEN = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;

export function parseQuery(query: string): Clause[] {
  const out: Clause[] = [];
  for (const m of query.matchAll(TOKEN)) {
    const field = m[2]?.toLowerCase() as Field | undefined;
    const known = field !== undefined && FIELDS.includes(field);
    const value = (m[3] ?? m[4] ?? "").toLowerCase();
    // An unknown "word:" prefix belongs to the text (a URL scheme, a time like 10:30, ...).
    const text = known ? value : `${m[2] ? `${m[2].toLowerCase()}:` : ""}${m[3] ?? m[4] ?? ""}`.toLowerCase();
    if (!text) continue;
    out.push({ not: m[1] === "-", ...(known ? { field } : {}), value: text });
  }
  return out;
}

const hostOf = (u: string): string => {
  try {
    return new URL(/^[a-z][\w+.-]*:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase();
  } catch {
    return "";
  }
};

function clauseMatches(c: Clause, i: Searchable): boolean {
  const has = (s: string) => s.toLowerCase().includes(c.value);
  switch (c.field) {
    case "title":
    case "name":
      return has(i.name);
    case "username":
      return has(i.sub);
    case "email":
      return i.sub.includes("@") && has(i.sub);
    case "url":
      return i.uris.some(has);
    case "domain":
    case "host":
      return i.uris.some((u) => hostOf(u).includes(c.value));
    case "folder":
      return has(i.folder);
    case "type":
      return i.type.some((n) => n.toLowerCase().startsWith(c.value));
    case "is":
      return i.flags.includes(c.value);
    default:
      return [i.name, i.sub, ...i.uris].some(has);
  }
}

/** Every positive clause must match and no excluded clause may. */
export const matchesQuery = (clauses: Clause[], item: Searchable): boolean => clauses.every((c) => clauseMatches(c, item) !== c.not);
