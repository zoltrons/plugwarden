// Vault screens: list (search, filters, sort), item view, Login/Note/Card/Identity editor, generator.
// Talks to the service worker only; decrypted data lives here just while the popup is open.
import type { FillResult, PageLogin } from "../autofill/page.ts";
import { URI_MATCH, URI_MATCH_ADVANCED } from "../shared/constants.ts";
import { cardBrand, groupCardNumber, luhnValid } from "../shared/card.ts";
import { hasMarkup } from "../shared/markdown.ts";
import { MAX_QR_BYTES } from "../shared/qr.ts";
import { type Clause, matchesQuery, parseQuery, type Searchable } from "../shared/search.ts";
import { passwordLevel } from "../shared/strength.ts";
import { isInsecureUri, mainPage, toHttps } from "../shared/uri-tools.ts";
import type { HistoryEntry, PageMatches, Settings, VaultItem, VaultList } from "../shared/messages.ts";
import { type Child, h, send, t, withChevron } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import { pwnedCount } from "./pwned.ts";
import { qrSvg } from "./qr.ts";

type Json = Record<string, unknown>;
export interface Ctx {
  rerender(): void;
  lock(): void;
  /** The account email (default for plus-addressed usernames). */
  email(): string | undefined;
  /** Current settings (per-item options depend on the account-level ones). */
  settings(): Settings | undefined;
  /** Switch the popup's tab (e.g. from the generator to a new vault item). */
  goto(tab: "vault" | "send"): void;
  /** Open the Send tab with a new text send holding `text`. */
  shareAsSend(text: string): void;
}

type Sort = "name" | "nameDesc" | "updated" | "created" | "opened";
type Route = { kind: "list" } | { kind: "item"; id: string } | { kind: "edit"; isNew: boolean } | { kind: "folders" };

interface EditDraft {
  base: Json;
  type: number;
  name: string;
  notes: string;
  folderId: string;
  favorite: boolean;
  /** Ask for the master password before this item is shown, copied or filled. */
  reprompt: boolean;
  /** Type-specific fields (SCHEMA) by key. */
  data: Record<string, string>;
  /** Login websites with their own match strategy (null = the account default). */
  uris: { uri: string; match: number | null }[];
  /** Tri-state "Autofill on page load" (null = the account default). */
  autofillOnPageLoad: boolean | null;
  fields: { name: string; value: string; type: number; linkedId?: unknown }[];
}

const GEN_DEFAULTS: Json = {
  type: "password", length: 20, lowercase: true, uppercase: true, numbers: true, special: true, avoidAmbiguous: false, minLowercase: 1, minUppercase: 1, minNumber: 1, minSpecial: 1,
  numWords: 5, wordSeparator: "-", capitalize: true, includeNumber: true, pinLength: 4,
  usernameType: "word", email: "", domain: "",
};
const GEN_KEY = "genOptions";
const WORDLIST_KEY = "genWordlist";

/** The generator's last options (a device preference, like the sort order). */
function savedGen(): Json {
  try {
    const v = JSON.parse(localStorage.getItem(GEN_KEY) ?? "null");
    return { ...GEN_DEFAULTS, ...(v && typeof v === "object" && !Array.isArray(v) ? v : {}) };
  } catch {
    return { ...GEN_DEFAULTS }; // no storage in framed pages, or damaged JSON
  }
}

function savedWordlist(): string[] {
  try {
    return (localStorage.getItem(WORDLIST_KEY) ?? "").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** One word per line; empty lines and lines starting with # ; - / are comments (Keyguard's format). */
function parseWordlist(text: string): string[] {
  const words = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim();
    if (w && w.length <= 24 && !/^[#;\-/]/.test(w)) words.add(w);
  }
  return [...words].slice(0, 100_000);
}

/** What the worker gets: the saved options, plus the custom list for a passphrase. */
function genOptions(): Json {
  const o: Json = { ...st.gen };
  if (o.type === "pin") o.length = o.pinLength;
  if (o.type === "passphrase") {
    const words = savedWordlist();
    if (words.length >= 100) o.wordlist = words;
  }
  return o;
}

const SORT_KEY = "vaultSort";
const SORTS: { id: Sort; label: string }[] = [
  { id: "name", label: "sortNameAsc" },
  { id: "nameDesc", label: "sortNameDesc" },
  { id: "updated", label: "sortUpdated" },
  { id: "created", label: "sortCreated" },
  { id: "opened", label: "sortOpened" },
];

// How often and when each item was opened: a device habit like the sort order, never synced.
const OPENED_KEY = "vaultOpened";
type Opened = Record<string, { n: number; at: number }>;

function loadOpened(): Opened {
  try {
    return JSON.parse(localStorage.getItem(OPENED_KEY) ?? "{}") as Opened;
  } catch {
    return {};
  }
}

function noteOpened(id: string) {
  try {
    const all = loadOpened();
    all[id] = { n: (all[id]?.n ?? 0) + 1, at: Date.now() };
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 200); // bounded
    localStorage.setItem(OPENED_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    /* no storage */
  }
}

function savedSort(): Sort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (SORTS.some((s) => s.id === v)) return v as Sort;
  } catch {
    /* framed pages have no storage */
  }
  return "name";
}

const st = {
  list: undefined as VaultList | undefined,
  page: undefined as PageMatches | undefined,
  loading: false,
  syncing: false,
  busy: false,
  error: undefined as string | undefined,
  route: { kind: "list" } as Route,
  query: "",
  /** "" all, "fav", "t:<type>", a folder id, "none" (no folder) or "trash". */
  folder: "",
  sort: savedSort(),
  item: undefined as Json | undefined,
  /** The item fetch is running: an error must not retrigger it on the next render. */
  itemLoading: false,
  /** Cipher id whose fetch failed: never retry it until the screen is opened again. */
  itemFailedFor: undefined as string | undefined,
  /** Cipher id whose master-password re-prompt screen is showing. */
  repromptFor: undefined as string | undefined,
  reveal: new Set<string>(),
  totp: undefined as { code: string; period: number; remaining: number } | undefined,
  /** Timestamp of the first tap of a two-tap destructive action; 0 when idle. */
  confirmDelete: 0,
  draft: undefined as EditDraft | undefined,
  gen: savedGen(),
  generated: "",
  /** Ready-made password variants shown under the generator. */
  suggestions: [] as string[],
  /** Generator history screen, while open. */
  history: undefined as HistoryEntry[] | undefined,
  toast: "",
  /** Large Type screen: the text being shown. */
  large: undefined as string | undefined,
  /** Editor: show the rendered notes under the text box. */
  notesPreview: false,
  /** QR screen: what is encoded, and an optional line under the code. */
  qr: undefined as { text: string; note?: string } | undefined,
  /** Breach check result for the open item's password. */
  pwned: undefined as { text: string; bad: boolean } | undefined,
  /** Memory test of the open item's password: asking, then the last verdict. */
  memory: undefined as { ok?: boolean } | undefined,
  /** Key of the field/row that was copied last (shows a check instead of the copy icon). */
  copied: "",
  /** The search box was focused once for this session; later renders keep the user's focus. */
  sawList: false,
  /** Editor: URI rows whose match-detection select is open, by index. */
  uriOpen: new Set<number>(),
};
let totpTimer: ReturnType<typeof setInterval> | undefined;
/** An open flagged item re-checks its grant: it expires, and dies with the service worker. */
let repromptTimer: ReturnType<typeof setInterval> | undefined;
const REPROMPT_CHECK_MS = 10_000;

function stopRepromptWatch() {
  clearInterval(repromptTimer);
  repromptTimer = undefined;
}

export function resetVault(): void {
  clearInterval(totpTimer);
  stopRepromptWatch();
  closeMenu();
  Object.assign(st, {
    list: undefined, page: undefined, loading: false, syncing: false, busy: false, error: undefined, route: { kind: "list" }, query: "",
    folder: "", item: undefined, reveal: new Set(), totp: undefined, confirmDelete: 0, draft: undefined,
    large: undefined, qr: undefined, pwned: undefined, memory: undefined, notesPreview: false,
    gen: savedGen(), generated: "", suggestions: [], history: undefined, toast: "", copied: "", sawList: false, uriOpen: new Set(),
  });
}

/** Which screen the vault tab is showing; the popup remembers a scroll position per key. */
export function vaultRouteKey(): string {
  const r = st.route;
  return r.kind === "list" ? "list" : r.kind === "item" ? `item:${r.id}` : r.kind === "edit" ? `edit:${r.isNew ? "new" : "item"}` : "folders";
}

// ---------- helpers ----------

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

function hue(s: string): number {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

/** An absolute http(s) URL for `u`, or undefined when it is not one. */
function webUrl(u: string): string | undefined {
  try {
    const url = new URL(/^[a-z][\w+.-]*:/i.test(u) ? u : `https://${u}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The server's icon service (`<server>/icons/<host>/icon.png`); unset when website icons are off. */
let iconBase: string | undefined;
export const setIconBase = (base: string | undefined) => (iconBase = base);

function iconUrl(uris: string[]): string | undefined {
  for (const u of iconBase ? uris : []) {
    const url = webUrl(u);
    if (url) return `${iconBase}/${new URL(url).hostname}/icon.png`;
  }
  return undefined;
}

/** A tinted letter tile; logins with a website get the server's favicon instead. */
export function tile(name: string, type: number, uris: string[] = []): HTMLElement {
  const letter = name.trim().slice(0, 1).toUpperCase();
  const fallback: IconName = type === 2 ? "note" : type === 3 ? "card" : type === 4 ? "user" : type === 5 ? "key" : "key";
  const el = h("span", { class: "tile", style: `--h:${hue(name)}`, "aria-hidden": "true" }, letter || icon(fallback));
  const src = type === 1 ? iconUrl(uris) : undefined;
  if (src) el.replaceChildren(h("img", { src, alt: "", onerror: () => el.replaceChildren(letter || icon(fallback)) }));
  return el;
}

/** Password digits and symbols get their own colors, like the rest of the app. */
function colorize(value: string): (Node | string)[] {
  return [...value].map((c) => (/\d/.test(c) ? h("span", { class: "d" }, c) : /[^\p{L}\s]/u.test(c) ? h("span", { class: "s" }, c) : c));
}

export function toast(ctx: Ctx, text: string) {
  st.toast = text;
  ctx.rerender();
  setTimeout(() => {
    if (st.toast === text) {
      st.toast = "";
      ctx.rerender();
    }
  }, 1800);
}

export async function copy(ctx: Ctx, value: string, key?: string) {
  await navigator.clipboard.writeText(value);
  void send({ type: "clipboardCopied" }); // schedules clearing
  toast(ctx, t("copied"));
  if (!key) return;
  // The copy icon turns into a check for a moment, so the action is visible without reading the toast.
  st.copied = key;
  ctx.rerender();
  setTimeout(() => {
    if (st.copied === key) {
      st.copied = "";
      ctx.rerender();
    }
  }, 1400);
}

export function iconButton(ic: IconName, label: string, onclick: () => void, extra: Record<string, unknown> = {}) {
  return h("button", { type: "button", class: "icon-btn", "aria-label": label, title: label, onclick, ...extra }, icon(ic));
}

function copyButton(ctx: Ctx, key: string, value: string, label: string) {
  const done = st.copied === key;
  return h(
    "button",
    {
      type: "button",
      class: `icon-btn${done ? " done" : ""}`,
      "aria-label": label,
      title: label,
      onclick: () => void copy(ctx, value, key),
    },
    icon(done ? "check" : "copy"),
  );
}

function errorBox(): Child {
  return st.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, st.error)) : null;
}

export function toastEl(): Child {
  return st.toast ? h("div", { class: "toast", role: "status" }, icon("check"), st.toast) : null;
}

function topBar(...children: Child[]): HTMLElement {
  return h("div", { class: "top" }, ...children);
}

function spacer(): HTMLElement {
  return h("span", { class: "spacer" });
}

function sectionTitle(text: string): HTMLElement {
  return h("h2", { class: "section-title" }, text);
}

function section(title: string, ...rows: Child[]): Child[] {
  const present = rows.filter(Boolean);
  return present.length ? [sectionTitle(title), h("div", { class: "group" }, ...present)] : [];
}

function progress(): HTMLElement {
  return h("div", { class: "progress" }, h("span", { class: "sr-only" }, t("loading", "")));
}

// ---------- popover menu ----------

let openMenuEl: HTMLElement | undefined;

function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = undefined;
}

interface MenuItem {
  label: string;
  icon?: IconName;
  checked?: boolean;
  onClick: () => void;
}

/** A small popover menu anchored under a button; light-dismiss and Escape come from the platform. */
function menu(anchor: HTMLElement, label: string, items: MenuItem[], radio = false) {
  closeMenu();
  const el = h(
    "div",
    { class: "menu", popover: "auto", role: "menu", "aria-label": label },
    ...items.map((it) =>
      h(
        "button",
        {
          type: "button",
          class: "menu-item",
          role: radio ? "menuitemradio" : "menuitem",
          ...(radio ? { "aria-checked": String(!!it.checked) } : {}),
          onclick: () => {
            closeMenu();
            it.onClick();
          },
        },
        it.icon ? icon(it.icon) : h("span", { class: "menu-gap" }),
        h("span", { class: "grow" }, it.label),
        it.checked ? icon("check") : null,
      ),
    ),
  );
  document.body.append(el);
  openMenuEl = el;
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.round(r.bottom + 6)}px`;
  el.style.right = `${Math.round(Math.max(8, window.innerWidth - r.right))}px`;
  el.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState === "closed" && openMenuEl === el) openMenuEl = undefined;
  });
  el.showPopover();
  // Keep keyboard users in the menu: focus its first item.
  (el.querySelector("[role=menuitem], [role=menuitemradio]") as HTMLElement | null)?.focus();
}

// ---------- data ----------

async function loadList(ctx: Ctx) {
  st.loading = true;
  const r = await send<VaultList>({ type: "vaultList" });
  st.loading = false;
  if (r.ok) st.list = r.data;
  else st.error = r.error;
  ctx.rerender();
  if (!r.ok) return;
  const p = await send<PageMatches>({ type: "pageMatches" });
  if (p.ok) st.page = p.data;
  await syncNow(ctx, false);
}

/** Re-reads the logins matching the active tab (e.g. after the default URI match setting changed). */
export async function refreshPageMatches(): Promise<void> {
  const p = await send<PageMatches>({ type: "pageMatches" });
  if (p.ok) st.page = p.data;
}

async function syncNow(ctx: Ctx, force: boolean) {
  st.syncing = true;
  ctx.rerender();
  const r = await send<VaultList | null>({ type: "sync", force });
  st.syncing = false;
  if (r.ok && r.data) {
    st.list = r.data;
    // New data can add matches for the current site.
    const p = await send<PageMatches>({ type: "pageMatches" });
    if (p.ok) st.page = p.data;
  }
  if (!r.ok) st.error = r.error;
  ctx.rerender();
}

function open(ctx: Ctx, route: Route) {
  clearInterval(totpTimer);
  stopRepromptWatch();
  Object.assign(st, { route, error: undefined, confirmDelete: 0, totp: undefined, large: undefined, qr: undefined, notesPreview: false, pwned: undefined, memory: undefined, reveal: new Set(), copied: "", uriOpen: new Set(), repromptFor: undefined, itemFailedFor: undefined });
  if (route.kind !== "edit") st.draft = undefined;
  if (route.kind === "item") noteOpened(route.id);
  ctx.rerender();
}

// ---------- list ----------

const TYPE_LABEL: Record<number, string> = { 1: "typeLogin", 2: "typeNote", 3: "typeCard", 4: "typeIdentity", 5: "typeSshKey" };

const TYPE_ENGLISH: Record<number, string> = { 1: "login", 2: "note", 3: "card", 4: "identity", 5: "ssh" };

function searchable(i: VaultItem): Searchable {
  const typeKey = TYPE_LABEL[i.type];
  const flags = [i.favorite && "favorite", i.reused && "reused", i.weak && "weak", i.hasTotp && "totp", i.reprompt && "reprompt"].filter((f): f is string => !!f);
  return {
    name: i.name,
    sub: i.sub,
    uris: i.uris,
    folder: st.list?.folders.find((f) => f.id === i.folderId)?.name ?? "",
    type: [typeKey ? t(typeKey) : "", TYPE_ENGLISH[i.type] ?? ""].filter(Boolean),
    flags,
  };
}

function matches(i: VaultItem, clauses: Clause[]): boolean {
  const f = st.folder;
  if (f === "fav") {
    if (!i.favorite) return false;
  } else if (f.startsWith("t:")) {
    if (i.type !== Number(f.slice(2))) return false;
  } else if (f === "reused") {
    if (!i.reused) return false;
  } else if (f === "weak") {
    if (!i.weak) return false;
  } else if (f === "none") {
    if (i.folderId) return false;
  } else if (f && f !== "trash" && i.folderId !== f) return false;
  return !clauses.length || matchesQuery(clauses, searchable(i));
}

function sortItems(items: VaultItem[]): VaultItem[] {
  const byName = (a: VaultItem, b: VaultItem) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const list = [...items];
  if (st.sort === "nameDesc") return list.sort((a, b) => byName(b, a));
  if (st.sort === "updated") return list.sort((a, b) => (b.revisionDate ?? 0) - (a.revisionDate ?? 0) || byName(a, b));
  if (st.sort === "created") return list.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0) || byName(a, b));
  if (st.sort === "opened") {
    const opened = loadOpened();
    return list.sort((a, b) => (opened[b.id]?.n ?? 0) - (opened[a.id]?.n ?? 0) || byName(a, b));
  }
  return list.sort(byName);
}

function itemRow(ctx: Ctx, i: VaultItem): HTMLElement {
  const name = i.failed ? t("decryptFailed") : i.name || t("untitled");
  return h(
    "button",
    {
      type: "button",
      class: "row",
      role: "listitem",
      "aria-label": t("showItem", name),
      onclick: () => open(ctx, { kind: "item", id: i.id }),
    },
    tile(i.name, i.type, i.uris),
    h(
      "div",
      { class: "body" },
      h("span", { class: "title" }, name),
      h("span", { class: "sub" }, i.sub || t(TYPE_LABEL[i.type] ?? "untitled")),
    ),
    i.hasTotp ? h("span", { class: "meta" }, icon("timer", t("oneTimeCode"))) : null,
    i.reused || i.weak ? h("span", { class: "meta warn" }, icon("error", t(i.reused ? "filterReused" : "filterWeak"))) : null,
    i.favorite ? h("span", { class: "meta fav" }, icon("star", t("favorite"))) : null,
    icon("chevron"),
  );
}

function emptyState(ctx: Ctx, q: string): HTMLElement {
  const filtered = !!(q || st.folder);
  const key = st.folder === "trash" ? "trashEmpty" : st.folder === "fav" ? "favoritesEmpty" : filtered ? "noMatches" : "vaultEmpty";
  return h(
    "div",
    { class: "empty" },
    icon(filtered ? "search" : "vault"),
    h("strong", {}, t(key)),
    filtered
      ? h(
          "button",
          {
            type: "button",
            class: "btn text small",
            onclick: () => {
              st.query = "";
              st.folder = "";
              ctx.rerender();
            },
          },
          t("clearFilters"),
        )
      : null,
  );
}

function fillList(ctx: Ctx, box: HTMLElement, items: VaultItem[], q: string) {
  const nodes: Child[] = [];
  const grouped = st.sort === "name" || st.sort === "nameDesc";
  const pushGroup = (list: VaultItem[]) => nodes.push(h("div", { class: "group" }, ...list.map((i) => itemRow(ctx, i))));
  if (!items.length) {
    nodes.push(emptyState(ctx, q));
  } else {
    // Recently opened items come first while browsing a vault big enough to need them.
    if (!q && !st.folder && items.length > 8) {
      const opened = loadOpened();
      const recent = items.filter((i) => opened[i.id]).sort((a, b) => opened[b.id]!.at - opened[a.id]!.at).slice(0, 3);
      if (recent.length) {
        nodes.push(sectionTitle(t("recentlyOpened")));
        pushGroup(recent);
      }
    }
    // Favorites float to the top while browsing; a letter index is kept for the rest.
    const favs = q ? [] : items.filter((i) => i.favorite);
    const rest = favs.length ? items.filter((i) => !i.favorite) : items;
    if (favs.length) {
      nodes.push(sectionTitle(t("favorites")));
      pushGroup(favs);
    }
    if (!grouped) {
      if (rest.length) pushGroup(rest);
    } else {
      let letter = "";
      let bucket: VaultItem[] = [];
      const flush = () => {
        if (!bucket.length) return;
        nodes.push(h("h2", { class: "letter" }, letter));
        pushGroup(bucket);
        bucket = [];
      };
      for (const i of rest) {
        const l = /[\p{L}\p{N}]/u.test(i.name[0] ?? "") ? i.name[0]!.toUpperCase() : "#";
        if (l !== letter) {
          flush();
          letter = l;
        }
        bucket.push(i);
      }
      flush();
    }
  }
  box.replaceChildren(...(nodes.filter(Boolean) as Node[]));
}

function arrowNav(box: HTMLElement) {
  box.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = [...box.querySelectorAll<HTMLElement>("[role=listitem]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  });
}

function skeletonList(): HTMLElement {
  return h(
    "div",
    { class: "group", "aria-hidden": "true" },
    ...Array.from({ length: 7 }, () =>
      h(
        "div",
        { class: "row skeleton" },
        h("span", { class: "tile skeleton-tile" }),
        h("div", { class: "body" }, h("span", { class: "skeleton-line w40" }), h("span", { class: "skeleton-line w70" })),
      ),
    ),
  );
}

function listView(ctx: Ctx): HTMLElement {
  if (st.folder === "trash" && st.list && !st.list.trash.length) st.folder = ""; // the trash was emptied
  const listBox = h("div", { class: "list-body", role: "list", "aria-label": t("vault") });
  arrowNav(listBox);
  const redraw = () => {
    const q = st.query.trim().toLowerCase();
    const source = st.folder === "trash" ? st.list?.trash : st.list?.items;
    const clauses = parseQuery(st.query);
    const items = sortItems((source ?? []).filter((i) => matches(i, clauses)));
    fillList(ctx, listBox, items, q);
  };
  redraw();

  const input = h("input", {
    id: "vault-search",
    type: "search",
    placeholder: t("searchVault"),
    "aria-label": t("searchVault"),
    title: t("searchHint"),
    value: st.query,
    ...(st.sawList ? {} : { "data-autofocus": "1" }),
    oninput: (e: Event) => {
      st.query = (e.target as HTMLInputElement).value;
      clearBtn.hidden = !st.query;
      redraw(); // list only, so the search box keeps focus and caret
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Escape" && st.query) {
        e.stopPropagation();
        st.query = "";
        input.value = "";
        clearBtn.hidden = true;
        redraw();
      }
    },
  });
  st.sawList = true;
  const clearBtn = h(
    "button",
    {
      type: "button",
      class: "icon-btn sm",
      "aria-label": t("clearSearch"),
      title: t("clearSearch"),
      hidden: !st.query,
      onclick: () => {
        st.query = "";
        input.value = "";
        clearBtn.hidden = true;
        redraw();
        input.focus();
      },
    },
    icon("close"),
  );

  const sortButton = iconButton("sort", t("sort"), () => {}, { class: "icon-btn sm", "aria-haspopup": "menu" });
  sortButton.onclick = () =>
    menu(
      sortButton,
      t("sort"),
      SORTS.map((s) => ({
        label: t(s.label),
        checked: st.sort === s.id,
        onClick: () => {
          st.sort = s.id;
          try {
            localStorage.setItem(SORT_KEY, s.id);
          } catch {
            /* no storage */
          }
          ctx.rerender();
        },
      })),
      true,
    );

  const folders = st.list?.folders ?? [];
  const chip = (id: string, label: string, ic?: IconName) =>
    h(
      "button",
      {
        type: "button",
        class: "chip",
        id: `chip-${id}`,
        "aria-pressed": String(st.folder === id),
        onclick: () => {
          st.folder = st.folder === id ? "" : id;
          ctx.rerender();
        },
      },
      ic ? icon(ic) : null,
      label,
    );

  return h(
    "div",
    { class: "page list-page" },
    topBar(
      h("div", { class: "search" }, icon("search"), input, clearBtn),
      sortButton,
      iconButton("refresh", t("syncNow"), () => void syncNow(ctx, true), { class: `icon-btn sm${st.syncing ? " spin" : ""}`, disabled: st.syncing }),
      iconButton("lock", t("lockNow"), () => ctx.lock(), { class: "icon-btn sm" }),
    ),
    h(
      "div",
      { class: "chips scroll", role: "group", "aria-label": t("filters") },
      chip("fav", t("favorites"), "star"),
      chip("t:1", t("typeLogin"), "key"),
      chip("t:3", t("typeCard"), "card"),
      chip("t:4", t("typeIdentity"), "user"),
      chip("t:2", t("typeNote"), "note"),
      st.list?.items.some((i) => i.reused) ? chip("reused", t("filterReused"), "error") : null,
      st.list?.items.some((i) => i.weak) ? chip("weak", t("filterWeak"), "error") : null,
      ...folders.map((f) => chip(f.id, f.name, "folder")),
      folders.length ? chip("none", t("noFolder"), "folder") : null,
      st.list?.trash.length ? chip("trash", t("trashCount", String(st.list.trash.length)), "trash") : null,
      h("button", { type: "button", class: "chip", onclick: () => open(ctx, { kind: "folders" }) }, icon("edit"), t("folders")),
    ),
    errorBox(),
    st.query || st.folder ? null : suggestions(ctx),
    st.loading && !st.list ? skeletonList() : listBox,
    h("button", { type: "button", class: "fab", onclick: () => startEdit(ctx, undefined) }, icon("plus"), t("newItem")),
  );
}

// ---------- this site ----------

async function fill(ctx: Ctx, id: string) {
  const r = await send<FillResult>({ type: "fill", id });
  if (r.ok && r.data.filled) window.close();
  // A flagged item: its view shows the master-password screen (itemView gets "reprompt" from getItem).
  else if (!r.ok && r.code === "reprompt") open(ctx, { kind: "item", id });
  else toast(ctx, r.ok ? t("fillFailed") : r.error);
}

/** Save what the user typed on the page: update the login with the same username, or create one. */
async function saveFromPage(ctx: Ctx) {
  const r = await send<PageLogin | null>({ type: "readPageLogin" });
  if (!r.ok || !r.data) return toast(ctx, r.ok ? t("noLoginOnPage") : r.error);
  const login = r.data;
  const same = st.page?.items.find((i) => i.type === 1 && !i.readOnly && i.sub === login.username);
  if (same) {
    const item = await send<Json>({ type: "getItem", id: same.id });
    if (item.ok) return startEdit(ctx, item.data, { data: { password: login.password } });
    if (item.code === "reprompt") return open(ctx, { kind: "item", id: same.id }); // never fall through to a duplicate
  }
  const url = new URL(login.url);
  startEdit(ctx, undefined, { name: url.hostname, data: { username: login.username, password: login.password }, uris: [{ uri: url.origin, match: null }] });
}

/** A row of the site section: the body opens the item, the button fills it (cards and identities too). */
function suggestionRow(ctx: Ctx, i: VaultItem): HTMLElement {
  const name = i.name || t("untitled");
  return h(
    "div",
    { class: "row" },
    h(
      "button",
      { type: "button", class: "row-main", "aria-label": t("showItem", name), onclick: () => open(ctx, { kind: "item", id: i.id }) },
      tile(i.name, i.type, i.uris),
      h("div", { class: "body" }, h("span", { class: "title" }, name), i.sub ? h("span", { class: "sub" }, i.sub) : null),
    ),
    h("button", { type: "button", class: "btn tonal small", "aria-label": `${t("fill")} ${i.name}`, onclick: () => void fill(ctx, i.id) }, icon("key"), t("fill")),
  );
}

function suggestions(ctx: Ctx): Child {
  const page = st.page;
  if (!page?.host) return null;
  // Only logins are tied to the page by their URIs. A card or an identity belongs to no site, so it
  // never appears under the site heading: it gets a heading of its own, like the official client.
  const group = (title: string, type: number): Child[] => {
    const items = page.items.filter((i) => i.type === type);
    return items.length ? [sectionTitle(title), h("div", { class: "group" }, ...items.map((i) => suggestionRow(ctx, i)))] : [];
  };
  return h(
    "section",
    { class: "suggestions", "aria-label": page.host },
    ...group(t("onThisSite", page.host), 1),
    ...group(t("typeCards"), 3),
    ...group(t("typeIdentities"), 4),
    h("button", { type: "button", class: "btn text small add-page", onclick: () => void saveFromPage(ctx) }, icon("plus"), t("saveFromPage")),
  );
}

// ---------- item types ----------

interface Spec {
  key: string;
  icon: IconName;
  secret?: boolean;
  mono?: boolean;
  options?: string[];
  area?: boolean;
}

const BRANDS = ["Visa", "Mastercard", "Amex", "Discover", "Diners Club", "JCB", "Maestro", "UnionPay", "RuPay", "Other"];
/** Type-specific fields per cipher type, in display order (labels: `field_<key>` in messages.json). */
const SCHEMA: Record<number, { obj: string; fields: Spec[] }> = {
  1: {
    obj: "login",
    fields: [
      { key: "username", icon: "user" },
      { key: "password", icon: "key", secret: true, mono: true },
      { key: "totp", icon: "timer", secret: true, mono: true },
    ],
  },
  3: {
    obj: "card",
    fields: [
      { key: "cardholderName", icon: "user" },
      { key: "brand", icon: "card", options: BRANDS },
      { key: "number", icon: "card", secret: true, mono: true },
      { key: "expMonth", icon: "timer", options: Array.from({ length: 12 }, (_, i) => String(i + 1)) },
      { key: "expYear", icon: "timer" },
      { key: "code", icon: "key", secret: true, mono: true },
    ],
  },
  4: {
    obj: "identity",
    fields: [
      { key: "title", icon: "user", options: ["Mr", "Mrs", "Ms", "Mx", "Dr"] },
      { key: "firstName", icon: "user" },
      { key: "middleName", icon: "user" },
      { key: "lastName", icon: "user" },
      { key: "username", icon: "user" },
      { key: "company", icon: "home" },
      { key: "email", icon: "mail" },
      { key: "phone", icon: "phone" },
      { key: "ssn", icon: "key", secret: true },
      { key: "passportNumber", icon: "key", secret: true },
      { key: "licenseNumber", icon: "key", secret: true },
      { key: "address1", icon: "home" },
      { key: "address2", icon: "home" },
      { key: "address3", icon: "home" },
      { key: "city", icon: "home" },
      { key: "state", icon: "home" },
      { key: "postalCode", icon: "home" },
      { key: "country", icon: "globe" },
    ],
  },
  5: {
    obj: "sshKey",
    fields: [
      { key: "privateKey", icon: "key", secret: true, mono: true, area: true },
      { key: "publicKey", icon: "key", mono: true },
      { key: "keyFingerprint", icon: "key", mono: true },
    ],
  },
};
const label = (key: string) => t(`field_${key}`);

function strength(pw: string): { label: string; level: number } {
  const level = passwordLevel(pw);
  return { level, label: t(["strengthWeak", "strengthFair", "strengthStrong", "strengthVeryStrong"][level]!) };
}

// ---------- item view ----------

/**
 * Master-password re-prompt, for items the user flagged in the web vault (`reprompt`). The worker
 * enforces it too: this screen only asks for the password that lifts the gate.
 */
function repromptView(ctx: Ctx, id: string): HTMLElement {
  const input = h("input", { id: "reprompt-password", type: "password", autocomplete: "current-password", required: true, "data-autofocus": "1", spellcheck: false });
  const onsubmit = async (e: Event) => {
    e.preventDefault();
    const password = input.value;
    input.value = "";
    st.busy = true;
    st.error = undefined;
    ctx.rerender();
    const r = await send({ type: "confirmReprompt", id, password });
    st.busy = false;
    if (!r.ok) st.error = r.error;
    else {
      st.repromptFor = undefined;
      st.item = undefined; // refetched with the gate lifted
    }
    ctx.rerender();
  };
  return h(
    "form",
    { class: "page center", onsubmit },
    topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" }))),
    h("div", { class: "brand" }, h("div", { class: "logo" }, icon("lock")), h("h1", {}, t("repromptTitle")), h("p", {}, t("repromptHint"))),
    h("div", { class: "field" }, icon("key"), h("label", { for: "reprompt-password" }, h("span", {}, t("masterPassword")), input)),
    errorBox(),
    st.busy ? progress() : null,
    h("div", { class: "actions" }, h("button", { type: "submit", class: "btn filled wide", disabled: st.busy }, t("repromptConfirm"))),
  );
}

function fieldRow(
  ctx: Ctx,
  key: string,
  ic: IconName,
  title: string,
  value: string,
  opts: { secret?: boolean; mono?: boolean; extra?: Child; copyValue?: string; menu?: MenuItem[]; display?: string } = {},
): HTMLElement {
  const shown = !opts.secret || st.reveal.has(key);
  const valueEl = h("span", { class: `value${opts.mono ? " mono" : ""}` });
  if (shown) {
    if (opts.mono && opts.secret) valueEl.append(...colorize(opts.display ?? value));
    else valueEl.textContent = opts.display ?? value;
  } else {
    valueEl.textContent = "•".repeat(Math.min(Math.max(value.length, 8), 16));
  }
  return h(
    "div",
    { class: `row field-row${opts.secret ? " elevated" : ""}` },
    icon(ic),
    h("div", { class: "body" }, h("span", { class: "label" }, title), valueEl, opts.extra),
    h(
      "span",
      { class: "field-actions" },
      opts.secret
        ? iconButton(shown ? "eyeOff" : "eye", t(shown ? "hidePassword" : "showPassword"), () => {
            if (shown) st.reveal.delete(key);
            else st.reveal.add(key);
            ctx.rerender();
          })
        : null,
      copyButton(ctx, key, opts.copyValue ?? value, t("copyField", title)),
      moreButton(ctx, value, opts.menu),
    ),
  );
}

/** "⋮" for a value: Large Type, share as a Send, plus whatever the row adds. */
function moreButton(ctx: Ctx, value: string, extra: MenuItem[] = []): HTMLElement {
  const items: MenuItem[] = [
    ...extra,
    { label: t("largeType"), icon: "search", onClick: () => ((st.large = value), ctx.rerender()) },
    ...(new TextEncoder().encode(value).length <= MAX_QR_BYTES ? [{ label: t("showQr"), onClick: () => ((st.qr = { text: value }), ctx.rerender()) }] : []),
    { label: t("shareAsSend"), icon: "send", onClick: () => ctx.shareAsSend(value) },
  ];
  const b: HTMLElement = iconButton("more", t("moreActions"), () => menu(b, t("moreActions"), items), { "aria-haspopup": "menu" });
  return b;
}

function qrView(ctx: Ctx): HTMLElement {
  const { text, note } = st.qr!;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((st.qr = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("qrCode"))),
    h("div", { class: "qr-box" }, qrSvg(text, t("qrCode"))),
    note ? h("p", { class: "caption center" }, note) : null,
  );
}

/** The authenticator key as an otpauth:// URI, which is what authenticator apps scan. */
function otpauthUri(secret: string, name: string): string {
  return secret.includes("://") ? secret : `otpauth://totp/${encodeURIComponent(name)}?secret=${encodeURIComponent(secret.replace(/\s+/g, ""))}`;
}

/** Every character on its own tile with its position, so look-alikes (O/0, l/1) can be told apart. */
function largeTypeView(ctx: Ctx): HTMLElement {
  const text = st.large!;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((st.large = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("largeType"))),
    h(
      "div",
      { class: "large mono", role: "img", "aria-label": text },
      ...[...text].map((c, i) => h("span", { class: `ch${/\d/.test(c) ? " d" : /[^\p{L}\s]/u.test(c) ? " s" : ""}` }, c === " " ? "␣" : c, h("small", {}, String(i + 1)))),
    ),
  );
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 9;

/** A countdown ring for the one-time code. */
function ring(fraction: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ring");
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(NS, "circle");
  track.setAttribute("cx", "12");
  track.setAttribute("cy", "12");
  track.setAttribute("r", "9");
  track.setAttribute("class", "ring-track");
  const bar = document.createElementNS(NS, "circle");
  bar.setAttribute("cx", "12");
  bar.setAttribute("cy", "12");
  bar.setAttribute("r", "9");
  bar.setAttribute("class", "ring-bar");
  bar.setAttribute("transform", "rotate(-90 12 12)");
  bar.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  bar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
  svg.append(track, bar);
  return svg;
}

function totpRow(ctx: Ctx, id: string, secret: string, name: string): HTMLElement {
  if (!st.totp) {
    void refreshTotp(ctx, id);
    return h("div", { class: "row" }, icon("timer"), h("div", { class: "body" }, h("span", { class: "label" }, t("oneTimeCode")), h("span", { class: "value" }, "…")));
  }
  const { code, remaining, period } = st.totp;
  const pretty = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  return h(
    "div",
    { class: "row field-row totp-row elevated" },
    icon("timer"),
    h("div", { class: "body" }, h("span", { class: "label" }, t("oneTimeCode")), h("span", { class: "value mono totp", "data-totp": "1" }, pretty)),
    h(
      "span",
      { class: "field-actions" },
      h(
        "span",
        { class: "totp-ring", "data-remaining": String(remaining), role: "img", "aria-label": t("secondsLeft", String(remaining)) },
        ring(remaining / Math.max(period, 1)),
        h("span", { class: "totp-seconds", "aria-hidden": "true" }, String(remaining)),
      ),
      copyButton(ctx, "totp", code, t("copyField", t("oneTimeCode"))),
      moreButton(ctx, code, [
        { label: t("copyAuthKey"), icon: "copy", onClick: () => void copy(ctx, secret) },
        { label: t("showAuthQr"), onClick: () => ((st.qr = { text: otpauthUri(secret, name), note: t("authQrNote") }), ctx.rerender()) },
      ]),
    ),
  );
}

/** The re-prompt grant ran out: hide the item again until the password is re-entered. */
function hideForReprompt(ctx: Ctx, id: string) {
  clearInterval(totpTimer);
  stopRepromptWatch();
  Object.assign(st, { item: undefined, totp: undefined, reveal: new Set(), copied: "", repromptFor: id });
  ctx.rerender();
}

async function refreshTotp(ctx: Ctx, id: string) {
  const r = await send<{ code: string; period: number; remaining: number }>({ type: "totp", id });
  if (st.route.kind !== "item" || st.route.id !== id) return;
  if (!r.ok) return r.code === "reprompt" ? hideForReprompt(ctx, id) : ctx.rerender();
  st.totp = { code: r.data.code, period: r.data.period || 30, remaining: r.data.remaining };
  ctx.rerender();
  clearInterval(totpTimer);
  totpTimer = setInterval(() => {
    if (!st.totp) return;
    st.totp.remaining -= 1;
    if (st.totp.remaining <= 0) {
      clearInterval(totpTimer);
      void refreshTotp(ctx, id);
      return;
    }
    // Tick the ring and the counter without re-rendering the whole screen.
    const pill = document.querySelector<HTMLElement>("[data-remaining]");
    if (!pill) return;
    pill.setAttribute("aria-label", t("secondsLeft", String(st.totp.remaining)));
    pill.setAttribute("data-remaining", String(st.totp.remaining));
    const seconds = pill.querySelector<HTMLElement>(".totp-seconds");
    if (seconds) seconds.textContent = String(st.totp.remaining);
    const bar = pill.querySelector<SVGCircleElement>(".ring-bar");
    if (bar) bar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - st.totp.remaining / st.totp.period));
  }, 1000);
}

const actionRow = (ic: IconName, title: string, onclick: () => void, danger = false) =>
  h("button", { type: "button", class: `row${danger ? " danger" : ""}`, disabled: st.busy, onclick }, icon(ic), h("div", { class: "body" }, h("span", { class: "title" }, title)));

async function vaultAction(ctx: Ctx, req: Parameters<typeof send>[0], done: string, back = true) {
  st.busy = true;
  ctx.rerender();
  const r = await send<VaultList>(req);
  st.busy = false;
  st.confirmDelete = 0;
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  st.list = r.data;
  st.item = undefined;
  if (back) open(ctx, { kind: "list" });
  else ctx.rerender();
  toast(ctx, t(done));
}

/** Arm a destructive action on the first tap, run it on the second; disarms itself after a while. */
function twoTap(ctx: Ctx, run: () => void) {
  if (!st.confirmDelete) {
    st.confirmDelete = Date.now();
    ctx.rerender();
    setTimeout(() => {
      if (!st.confirmDelete) return;
      st.confirmDelete = 0;
      if (st.route.kind === "item") ctx.rerender();
    }, 4000);
    return;
  }
  st.confirmDelete = 0;
  run();
}

// Same cap as Send files (MAX_SEND_FILE_BYTES in background/vault.ts).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

async function download(ctx: Ctx, cipherId: string, attachmentId: string) {
  const r = await send<{ fileName: string; data: string }>({ type: "downloadAttachment", cipherId, attachmentId });
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  const url = URL.createObjectURL(new Blob([Uint8Array.fromBase64(r.data.data)]));
  h("a", { href: url, download: safeFileName(r.data.fileName) }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The name comes from the server: keep it a plain file name (no separators, no control characters). */
function safeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").trim().slice(0, 100);
  return clean || "attachment";
}

async function upload(ctx: Ctx, cipherId: string, file: File | undefined) {
  if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) return ((st.error = t("fileTooLarge")), ctx.rerender());
  const data = new Uint8Array(await file.arrayBuffer()).toBase64();
  await vaultAction(ctx, { type: "addAttachment", cipherId, file: { name: file.name, data } }, "saved", false);
}

/** Fill / open actions for the item, when the active tab has a matching login or the item has a site. */
function quickActions(ctx: Ctx, id: string, uris: string[]): Child {
  const onSite = st.page?.items.some((i) => i.type === 1 && i.id === id);
  const url = uris.map(webUrl).find(Boolean);
  if (!onSite && !url) return null;
  return h(
    "div",
    { class: "quick" },
    onSite ? h("button", { type: "button", class: "btn tonal", onclick: () => void fill(ctx, id) }, icon("key"), t("fillThisSite")) : null,
    url
      ? h(
          "a",
          {
            class: "btn text",
            href: url,
            target: "_blank",
            rel: "noopener noreferrer",
            onclick: (e: Event) => {
              e.preventDefault();
              void chrome.tabs.create({ url });
            },
          },
          icon("external"),
          t("openWebsite"),
        )
      : null,
  );
}

async function checkBreach(ctx: Ctx, id: string, password: string) {
  st.pwned = { text: t("checking"), bad: false };
  ctx.rerender();
  let result: { text: string; bad: boolean };
  try {
    const n = await pwnedCount(password);
    result = n > 0 ? { text: t("pwnedFound", n.toLocaleString()), bad: true } : { text: t("pwnedClean"), bad: false };
  } catch {
    result = { text: t("pwnedFailed"), bad: false };
  }
  if (st.route.kind !== "item" || st.route.id !== id) return; // the user moved on
  st.pwned = result;
  ctx.rerender();
}

/** "Type it from memory": compared here, against the password the open item already holds. */
function memoryForm(ctx: Ctx, password: string): HTMLElement {
  const input = h("input", { type: "password", autocomplete: "off", spellcheck: false, "aria-label": t("memoryTest"), "data-autofocus": "1" });
  const verdict = st.memory?.ok;
  return h(
    "form",
    {
      class: "field-card add",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const ok = input.value === password;
        input.value = "";
        st.memory = { ok };
        ctx.rerender();
      },
    },
    h("p", { class: "caption" }, t("memoryHint")),
    h("div", { class: "field-card-bottom" }, input, h("button", { type: "submit", class: "btn tonal small" }, t("check"))),
    verdict === undefined ? null : h("div", { class: `notice ${verdict ? "info" : "warn"}` }, icon(verdict ? "check" : "error"), h("div", {}, t(verdict ? "memoryMatch" : "memoryMismatch"))),
  );
}

/** One row for a card's expiry: copies MMYY (what payment forms want), flags an expired or soon-to-expire card. */
function expiryRow(ctx: Ctx, month: string, year: string): HTMLElement | undefined {
  const m = Number(month);
  const y = Number(year);
  if (!(m >= 1 && m <= 12) || !Number.isInteger(y) || y < 0) return undefined;
  const y4 = y < 100 ? 2000 + y : y;
  const mm = String(m).padStart(2, "0");
  const left = new Date(y4, m, 1).getTime() - Date.now(); // a card works through the end of its month
  const status = left <= 0 ? "expired" : left < 60 * 86_400_000 ? "expiringSoon" : "";
  return fieldRow(ctx, "expiry", "timer", t("expiry"), `${mm}/${y4}`, {
    copyValue: `${mm}${String(y4).slice(-2)}`,
    menu: [
      { label: t("copyMonth"), icon: "copy", onClick: () => void copy(ctx, mm) },
      { label: t("copyYear"), icon: "copy", onClick: () => void copy(ctx, String(y4)) },
    ],
    extra: status ? h("span", { class: `badge ${status === "expired" ? "s0" : "s1"}` }, t(status)) : null,
  });
}

/** Mail, call, text and show-on-map shortcuts for an identity. Maps go to OpenStreetMap, not an ad network. */
function identityActions(data: Json): Child {
  const email = str(data.email).trim();
  const phone = str(data.phone).replace(/[^\d+*#]/g, "");
  const address = ["address1", "address2", "address3", "city", "state", "postalCode", "country"].map((k) => str(data[k]).trim()).filter(Boolean).join(", ");
  const link = (ic: IconName, label: string, href: string) => h("a", { class: "row", href, target: "_blank", rel: "noopener noreferrer", onclick: (e: Event) => (e.preventDefault(), void chrome.tabs.create({ url: href })) }, icon(ic), h("div", { class: "body" }, h("span", { class: "title" }, label)), icon("external"));
  const rows = [
    email ? link("mail", t("sendEmail"), `mailto:${encodeURIComponent(email)}`) : null,
    phone ? link("phone", t("callPhone"), `tel:${phone}`) : null,
    phone ? link("phone", t("textPhone"), `sms:${phone}`) : null,
    address ? link("home", t("showOnMap"), `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`) : null,
  ].filter(Boolean);
  return rows.length ? h("div", { class: "group" }, ...rows) : null;
}

/** A website row: open, copy, and a menu with the main page and the https upgrade. */
function uriRow(ctx: Ctx, index: number, uri: string, match: number | null, onHttps: ((to: string) => void) | undefined): HTMLElement {
  const href = webUrl(uri);
  const insecure = isInsecureUri(uri);
  const front = mainPage(uri);
  const https = onHttps ? toHttps(uri) : undefined;
  const items: MenuItem[] = [];
  if (front) items.push({ label: t("openMainPage"), icon: "home", onClick: () => void chrome.tabs.create({ url: front }) });
  if (https) items.push({ label: t("switchToHttps"), icon: "shield", onClick: () => onHttps!(https) });
  const sub = [insecure ? t("insecureUri") : "", match !== null ? uriMatchLabel(match) : ""].filter(Boolean).join(" · ");
  const more: HTMLElement = iconButton("more", t("moreActions"), () => menu(more, t("moreActions"), items), { "aria-haspopup": "menu" });
  return h(
    "div",
    { class: "row" },
    icon(insecure ? "error" : "globe"),
    h("div", { class: "body" }, h("span", { class: "title ellipsis" }, uri), sub ? h("span", { class: `sub${insecure ? " warn" : ""}` }, sub) : null),
    h("span", { class: "field-actions" }, href ? iconButton("external", t("openWebsite"), () => void chrome.tabs.create({ url: href })) : null, copyButton(ctx, `uri.${index}`, uri, t("copyField", uri)), items.length ? more : null),
  );
}

const NOTES_KEY = "formatNotes";
const notesFormatted = (): boolean => {
  try {
    return localStorage.getItem(NOTES_KEY) === "1";
  } catch {
    return false;
  }
};

function itemView(ctx: Ctx, id: string): HTMLElement {
  const item = st.item && st.item.id === id ? st.item : undefined;
  if (!item) {
    // The worker refuses to hand over a flagged item until the master password is re-entered.
    if (st.repromptFor === id) return repromptView(ctx, id);
    if (!st.itemLoading && st.itemFailedFor !== id) {
      st.itemLoading = true;
      void send<Json>({ type: "getItem", id }).then((r) => {
        st.itemLoading = false;
        if (r.ok) st.item = r.data;
        else if (r.code === "reprompt") st.repromptFor = id;
        else {
          st.error = r.error;
          st.itemFailedFor = id; // a failed fetch is shown, not retried in a loop
        }
        ctx.rerender();
      });
    }
    return h(
      "div",
      { class: "page" },
      topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" }))),
      errorBox(),
      st.error ? null : progress(),
    );
  }
  if (Number(item.reprompt) === 1 && !repromptTimer)
    repromptTimer = setInterval(async () => {
      const r = await send<boolean>({ type: "repromptGranted", id });
      if (r.ok && !r.data && st.route.kind === "item" && st.route.id === id) hideForReprompt(ctx, id);
    }, REPROMPT_CHECK_MS);
  const inTrash = !!item.deletedDate;
  const summary = [...(st.list?.items ?? []), ...(st.list?.trash ?? [])].find((i) => i.id === id);
  const type = Number(item.type);
  const editable = !summary?.readOnly && !inTrash && type >= 1 && type <= 5;
  const schema = SCHEMA[type];
  const data = schema ? (obj(item[schema.obj]) ?? {}) : {};
  const rows: Child[] = [];
  const expiry = type === 3 ? expiryRow(ctx, str(data.expMonth), str(data.expYear)) : undefined;
  for (const f of schema?.fields ?? []) {
    const v = str(data[f.key]);
    if (!v) continue;
    if (expiry && (f.key === "expMonth" || f.key === "expYear")) {
      if (f.key === "expMonth") rows.push(expiry);
      continue;
    }
    if (type === 1 && f.key === "totp") {
      rows.push(totpRow(ctx, id, v, str(item.name)));
      continue;
    }
    const s = type === 1 && f.key === "password" ? strength(v) : undefined;
    rows.push(fieldRow(ctx, f.key, f.icon, label(f.key), v, { secret: f.secret, mono: f.mono, display: type === 3 && f.key === "number" ? groupCardNumber(v) : undefined, extra: s ? h("span", { class: `badge s${s.level}` }, s.label) : null }));
  }
  const login = type === 1 ? data : undefined;
  const uriEntries = (Array.isArray(login?.uris) ? (login!.uris as Json[]) : [])
    .map((u) => ({ uri: str(u.uri), match: typeof u.match === "number" ? (u.match as number) : null }))
    .filter((u) => u.uri);
  const uris = uriEntries.map((u) => u.uri);
  const fields = Array.isArray(item.fields) ? (item.fields as Json[]) : [];
  const history = Array.isArray(item.passwordHistory) ? (item.passwordHistory as Json[]) : [];
  const folder = st.list?.folders.find((f) => f.id === item.folderId);
  const attachments = Array.isArray(item.attachments) ? (item.attachments as Json[]) : [];
  const org = st.list?.organizations?.find((o) => o.id === item.organizationId);
  const collections = (Array.isArray(item.collectionIds) ? (item.collectionIds as string[]) : []).map((c) => st.list?.collections?.find((x) => x.id === c)?.name).filter(Boolean);
  const date = (v: unknown) => (typeof v === "string" && v ? new Date(v).toLocaleString() : "");
  const passkeys = Array.isArray(login?.fido2Credentials) ? (login!.fido2Credentials as Json[]).length : 0;
  const confirm = st.confirmDelete > 0;
  const password = type === 1 ? str(data.password) : "";
  const reused = summary?.reused ?? 0;
  const formatted = notesFormatted();
  const notes = str(item.notes);
  const fixUri = (from: string, to: string) =>
    void vaultAction(ctx, { type: "saveItem", item: { ...item, login: { ...login, uris: (Array.isArray(login?.uris) ? (login!.uris as Json[]) : []).map((x) => (str(x.uri) === from ? { ...x, uri: to } : x)) } } }, "saved", false);

  return h(
    "div",
    {
      class: "page item-page",
      // A dropped file must never navigate the popup away; on an editable personal item it becomes an attachment.
      ondragover: (e: DragEvent) => e.preventDefault(),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        if (editable && !item.organizationId) void upload(ctx, id, e.dataTransfer?.files[0]);
      },
    },
    topBar(
      iconButton("back", t("back"), () => open(ctx, { kind: "list" })),
      spacer(),
      editable
        ? iconButton(item.favorite ? "star" : "starBorder", t(item.favorite ? "unfavorite" : "favorite"), () => void vaultAction(ctx, { type: "saveItem", item: { ...item, favorite: !item.favorite } }, "saved", false), {
            class: `icon-btn${item.favorite ? " on" : ""}`,
            "aria-pressed": String(item.favorite === true),
          })
        : null,
      editable ? iconButton("edit", t("edit"), () => startEdit(ctx, item)) : null,
    ),
    h(
      "div",
      { class: "hero" },
      tile(str(item.name), type, uris),
      h("div", { class: "body" }, h("h1", {}, str(item.name) || t("untitled")), h("span", { class: "sub" }, t(TYPE_LABEL[type] ?? "untitled"))),
    ),
    quickActions(ctx, id, uris),
    errorBox(),
    inTrash ? h("div", { class: "notice warn" }, icon("trash"), h("div", {}, t("inTrash"))) : summary?.readOnly ? h("div", { class: "notice" }, icon("lock"), h("div", {}, t("readOnlyItem"))) : null,
    rows.length ? h("div", { class: "group" }, ...rows) : null,
    type === 4 ? identityActions(data) : null,
    password
      ? h("div", { class: "group" }, actionRow("shield", t("checkBreaches"), () => void checkBreach(ctx, id, password)), actionRow("key", t("memoryTest"), () => ((st.memory = st.memory ? undefined : {}), ctx.rerender())))
      : null,
    st.pwned ? h("div", { class: `notice ${st.pwned.bad ? "warn" : "info"}` }, icon(st.pwned.bad ? "error" : "info"), h("div", {}, st.pwned.text)) : null,
    st.memory && password ? memoryForm(ctx, password) : null,
    reused
      ? h(
          "div",
          { class: "notice warn" },
          icon("error"),
          h("div", {}, t("reusedNotice", String(reused))),
          h("button", { type: "button", class: "btn text small", onclick: () => ((st.folder = "reused"), open(ctx, { kind: "list" })) }, t("showReused")),
        )
      : null,
    login?.passwordRevisionDate ? h("p", { class: "caption" }, t("passwordChanged", date(login.passwordRevisionDate))) : null,
    passkeys ? h("div", { class: "notice info" }, icon("key"), h("div", {}, t("passkeyAvailable"))) : null,
    ...section(
      t("websites"),
      ...uriEntries.map(({ uri: u, match }, i) => uriRow(ctx, i, u, match, editable ? (to) => fixUri(u, to) : undefined)),
    ),
    ...section(
      t("customFields"),
      ...fields.map((f, i) =>
        Number(f.type) === 3
          ? null
          : Number(f.type) === 2
            ? h(
                editable ? "button" : "div",
                {
                  class: "row",
                  ...(editable ? { type: "button", disabled: st.busy, onclick: () => void vaultAction(ctx, { type: "saveItem", item: { ...item, fields: fields.map((x, j) => (j === i ? { ...x, value: str(x.value) === "true" ? "false" : "true" } : x)) } }, "saved", false) } : {}),
                },
                icon("note"),
                h("div", { class: "body" }, h("span", { class: "label" }, str(f.name)), h("span", { class: "value" }, t(str(f.value) === "true" ? "yes" : "no"))),
              )
            : fieldRow(ctx, `field.${i}`, "note", str(f.name) || t("untitled"), str(f.value), { secret: Number(f.type) === 1 }),
      ),
    ),
    ...(notes
      ? [
          h(
            "div",
            { class: "section-head" },
            sectionTitle(t("notes")),
            hasMarkup(notes)
              ? h("button", { type: "button", class: "chip small", "aria-pressed": String(formatted), onclick: () => (localStorage.setItem(NOTES_KEY, formatted ? "0" : "1"), ctx.rerender()) }, t("formatNotes"))
              : null,
          ),
          formatted ? renderMarkdown(notes) : h("div", { class: "notes" }, notes),
        ]
      : []),
    ...section(
      t("passwordHistory"),
      ...(st.reveal.has("history")
        ? history.map((p, i) => fieldRow(ctx, `history.${i}`, "key", date(p.lastUsedDate), str(p.password), { secret: true, mono: true }))
        : history.length
          ? [actionRow("timer", t("showPasswordHistory", String(history.length)), () => (st.reveal.add("history"), ctx.rerender()))]
          : []),
    ),
    ...section(
      t("attachments"),
      ...attachments.map((a) =>
        h(
          "div",
          { class: "row" },
          icon("attach"),
          h("div", { class: "body" }, h("span", { class: "title ellipsis" }, str(a.fileName) || t("untitled")), h("span", { class: "sub" }, str(a.sizeName))),
          iconButton("download", `${t("download")} ${str(a.fileName)}`, () => void download(ctx, id, str(a.id))),
        ),
      ),
      editable && !inTrash && !item.organizationId
        ? h(
            "label",
            { class: "row" },
            icon("plus"),
            h("div", { class: "body" }, h("span", { class: "title" }, t("addAttachment"))),
            h("input", { type: "file", class: "sr-only", "aria-label": t("addAttachment"), onchange: (e: Event) => void upload(ctx, id, (e.target as HTMLInputElement).files?.[0]) }),
          )
        : null,
    ),
    ...section(
      t("details"),
      org ? h("div", { class: "row" }, icon("shield"), h("div", { class: "body" }, h("span", { class: "label" }, t("organization")), h("span", { class: "value" }, org.name))) : null,
      collections.length ? h("div", { class: "row" }, icon("folder"), h("div", { class: "body" }, h("span", { class: "label" }, t("collections")), h("span", { class: "value" }, collections.join(", ")))) : null,
      folder ? h("div", { class: "row" }, icon("folder"), h("div", { class: "body" }, h("span", { class: "label" }, t("folder")), h("span", { class: "value" }, folder.name))) : null,
      item.revisionDate ? h("div", { class: "row" }, icon("edit"), h("div", { class: "body" }, h("span", { class: "label" }, t("lastEdited")), h("span", { class: "value" }, date(item.revisionDate)))) : null,
    ),
    h(
      "div",
      { class: "group" },
      inTrash
        ? actionRow("refresh", t("restore"), () => void vaultAction(ctx, { type: "restoreItem", id }, "restored"))
        : editable
          ? actionRow("copy", t("clone"), () => startEdit(ctx, { ...structuredClone(item), id: undefined, attachments: null, name: `${str(item.name)} ${t("copySuffix")}`, passwordHistory: null }, {}, true))
          : null,
      inTrash
        ? actionRow("trash", t(confirm ? "confirmPurge" : "deleteForever"), () => twoTap(ctx, () => void vaultAction(ctx, { type: "purgeItem", id }, "deleted")), true)
        : editable
          ? actionRow("trash", t(confirm ? "confirmTrash" : "moveToTrash"), () => twoTap(ctx, () => void vaultAction(ctx, { type: "deleteItem", id }, "movedToTrash")), true)
          : null,
    ),
  );
}

// ---------- editor (Login, Secure note, Card, Identity) ----------

interface Prefill {
  name?: string;
  uris?: { uri: string; match: number | null }[];
  data?: Record<string, string>;
}

function startEdit(ctx: Ctx, item: Json | undefined, prefill: Prefill = {}, asNew = !item) {
  const base: Json = item ? structuredClone(item) : { type: 1, favorite: false, reprompt: 0, folderId: null, organizationId: null };
  const type = Number(base.type) || 1;
  const schema = SCHEMA[type];
  const data = Object.fromEntries((schema?.fields ?? []).map((f) => [f.key, str(obj(base[schema!.obj])?.[f.key])]));
  const login = obj(base.login);
  st.draft = {
    base,
    type,
    name: prefill.name ?? str(base.name),
    notes: str(base.notes),
    folderId: str(base.folderId),
    favorite: base.favorite === true,
    reprompt: Number(base.reprompt) === 1,
    data: { ...data, ...prefill.data },
    uris:
      prefill.uris ??
      (Array.isArray(login?.uris) ? (login!.uris as Json[]) : [])
        .map((u) => ({ uri: str(u.uri), match: typeof u.match === "number" ? u.match : null }))
        .filter((u) => u.uri),
    autofillOnPageLoad: typeof login?.autofillOnPageLoad === "boolean" ? (login.autofillOnPageLoad as boolean) : null,
    fields: (Array.isArray(base.fields) ? (base.fields as Json[]) : []).map((f) => ({ name: str(f.name), value: str(f.value), type: Number(f.type) || 0, linkedId: f.linkedId })),
  };
  open(ctx, { kind: "edit", isNew: asNew });
}

function buildItem(d: EditDraft): Json {
  const orNull = (s: string) => (s.trim() ? s : null);
  const item: Json = { ...d.base, type: d.type, name: d.name.trim(), notes: orNull(d.notes), folderId: d.folderId || null, favorite: d.favorite, reprompt: d.reprompt ? 1 : 0 };
  const schema = SCHEMA[d.type];
  for (const k of ["login", "secureNote", "card", "identity"]) if (k !== schema?.obj) delete item[k];
  if (schema) {
    const typed: Json = { ...obj(d.base[schema.obj]) };
    for (const f of schema.fields) typed[f.key] = orNull(d.data[f.key] ?? "");
    if (d.type === 1) {
      typed.uris = d.uris.map((u) => ({ uri: u.uri.trim(), match: u.match })).filter((u) => u.uri);
      typed.autofillOnPageLoad = d.autofillOnPageLoad;
    }
    item[schema.obj] = typed;
  } else item.secureNote = obj(d.base.secureNote) ?? { type: 0 };
  item.fields = d.fields
    .filter((f) => f.name.trim() || f.value)
    .map((f) => ({ name: f.name, value: f.type === 2 ? String(f.value === "true") : f.value || null, type: f.type, linkedId: f.linkedId ?? null }));
  return item;
}

/** Live strength readout under the password field; updated in place so the caret stays put. */
function strengthMeter(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const fill = h("i");
  const bar = h("div", { class: "meter", "aria-hidden": "true" }, fill);
  const text = h("span", { class: "meter-label" });
  const sync = (v: string) => {
    const s = strength(v);
    bar.dataset.level = String(s.level);
    text.textContent = v ? s.label : "";
    bar.hidden = !v;
  };
  sync(value);
  input.addEventListener("input", () => sync(input.value));
  return h("div", { class: "meter-wrap" }, bar, text);
}

/** The generator's strength bar, drawn once for the current value. */
function strengthBar(value: string): HTMLElement {
  return h("div", { class: "meter", "data-level": String(strength(value).level), "aria-hidden": "true" }, h("i"));
}

/** Labels for Bitwarden's UriMatchStrategy, as the clients name them. */
export function uriMatchLabel(match: number): string {
  const key =
    match === URI_MATCH.Host ? "uriMatchHost"
    : match === URI_MATCH.StartsWith ? "uriMatchStartsWith"
    : match === URI_MATCH.Exact ? "uriMatchExact"
    : match === URI_MATCH.RegularExpression ? "uriMatchRegex"
    : match === URI_MATCH.Never ? "uriMatchNever"
    : "uriMatchBaseDomainShort";
  return t(key);
}

/** The default's name, for the "Default (…)" option. */
function defaultUriMatchLabel(): string {
  return uriMatchLabel(settingsOf()?.defaultUriMatch ?? URI_MATCH.Domain);
}

const settingsOf = (): Settings | undefined => currentCtx?.settings();
let currentCtx: Ctx | undefined;

/** The editor's website rows: URI + match detection, with Add / Remove. */
function uriEditor(ctx: Ctx): Child[] {
  const d = st.draft!;
  const rows = d.uris.map((u, i) => {
    const open = st.uriOpen.has(i);
    const select = withChevron(
      h(
        "select",
        {
          "aria-label": t("matchDetection"),
          onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            u.match = v === "" ? null : Number(v);
            ctx.rerender();
          },
        },
        h("option", { value: "", selected: u.match === null }, t("defaultLabelWithValue", defaultUriMatchLabel())),
        h("option", { value: String(URI_MATCH.Domain), selected: u.match === URI_MATCH.Domain }, t("uriMatchBaseDomainShort")),
        h("option", { value: String(URI_MATCH.Host), selected: u.match === URI_MATCH.Host }, t("uriMatchHost")),
        h("option", { value: String(URI_MATCH.Exact), selected: u.match === URI_MATCH.Exact }, t("uriMatchExact")),
        h("option", { value: String(URI_MATCH.Never), selected: u.match === URI_MATCH.Never }, t("uriMatchNever")),
        h("option", { value: "advanced", disabled: true }, t("uriMatchAdvanced")),
        h("option", { value: String(URI_MATCH.StartsWith), selected: u.match === URI_MATCH.StartsWith }, t("uriMatchStartsWith")),
        h("option", { value: String(URI_MATCH.RegularExpression), selected: u.match === URI_MATCH.RegularExpression }, t("uriMatchRegex")),
      ),
    );
    return h(
      "div",
      { class: "field-card" },
      h(
        "div",
        { class: "field-card-top" },
        h("input", {
          class: "name",
          value: u.uri,
          placeholder: "https://example.com",
          "aria-label": t("uriLabel", String(i + 1)),
          autocapitalize: "off",
          spellcheck: false,
          oninput: (e: Event) => (u.uri = (e.target as HTMLInputElement).value),
        }),
        iconButton(open ? "settings" : "settings", t("matchDetection"), () => (open ? st.uriOpen.delete(i) : st.uriOpen.add(i), ctx.rerender()), {
          class: `icon-btn sm${open ? " on" : ""}`,
          "aria-pressed": String(open),
        }),
        ...moveButtons(ctx, d.uris, i, () => st.uriOpen.clear()),
        d.uris.length > 1
          ? iconButton("trash", t("removeWebsite"), () => (d.uris.splice(i, 1), st.uriOpen.clear(), ctx.rerender()), { class: "icon-btn sm" })
          : null,
      ),
      open ? h("div", { class: "field-card-bottom" }, select) : null,
      open ? h("p", { class: "caption" }, t("uriMatchHint")) : null,
      open && u.match !== null && URI_MATCH_ADVANCED.includes(u.match)
        ? h("p", { class: "caption warn" }, t(u.match === URI_MATCH.RegularExpression ? "uriMatchRegExHint" : "uriMatchStartsWithHint"))
        : null,
    );
  });
  return [
    sectionTitle(t("autofillOptions")),
    ...rows,
    h("button", { type: "button", class: "btn text small add-field", onclick: () => (d.uris.push({ uri: "", match: null }), ctx.rerender()) }, icon("plus"), t("addWebsite")),
  ];
}

/** The usernames used most across the vault's logins (list summaries only: no secrets involved). */
function usernameSuggestions(): string[] {
  const counts = new Map<string, number>();
  for (const i of st.list?.items ?? []) if (i.type === 1 && i.sub) counts.set(i.sub, (counts.get(i.sub) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([u]) => u);
}

type Detector = new (o: { formats: string[] }) => { detect(i: ImageBitmapSource): Promise<{ rawValue: string }[]> };
/** The platform's QR reader (macOS, Android, ChromeOS builds); absent elsewhere, where the button is hidden. */
const barcodeDetector = (): Detector | undefined => (globalThis as { BarcodeDetector?: Detector }).BarcodeDetector;

async function scanQr(file: File): Promise<string | undefined> {
  const Reader = barcodeDetector();
  if (!Reader) return undefined;
  return (await new Reader({ formats: ["qr_code"] }).detect(await createImageBitmap(file)))[0]?.rawValue;
}

/** Swap `list[i]` with its neighbour, for the editor's move up / down buttons. */
function moveItem<T>(list: T[], i: number, by: -1 | 1) {
  const j = i + by;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
}

const moveButtons = (ctx: Ctx, list: unknown[], i: number, reset?: () => void): Child[] => [
  i > 0 ? iconButton("chevron", t("moveUp"), () => (moveItem(list, i, -1), reset?.(), ctx.rerender()), { class: "icon-btn sm up" }) : null,
  i < list.length - 1 ? iconButton("chevron", t("moveDown"), () => (moveItem(list, i, 1), reset?.(), ctx.rerender()), { class: "icon-btn sm down" }) : null,
];

function editView(ctx: Ctx, isNew: boolean): HTMLElement {
  const d = st.draft!;
  const back = () => open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) });
  const field = (id: string, ic: IconName, title: string, control: HTMLElement, trailing?: Child) => {
    // A select is wrapped for its chevron: the label must point at the select itself.
    (control.querySelector("select") ?? control).id = id;
    return h("div", { class: "field" }, icon(ic), h("label", { for: id }, h("span", {}, title), control), trailing);
  };
  const text = (get: () => string, set: (v: string) => void, props: Record<string, unknown> = {}) => {
    const { area, ...rest } = props;
    return h(area ? "textarea" : "input", { ...rest, value: get(), oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
  };
  const select = (get: () => string, set: (v: string) => void, options: [string, string][]) =>
    withChevron(h("select", { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...options.map(([v, l]) => h("option", { value: v, selected: v === get() }, l))));

  const specField = (f: Spec) => {
    const get = () => d.data[f.key] ?? "";
    const set = (v: string) => (d.data[f.key] = v);
    const id = `edit-${f.key}`;
    if (f.options) return field(id, f.icon, label(f.key), select(get, set, [["", "—"], ...f.options.map((o): [string, string] => [o, o])]));
    // Card number: fill in the brand once the number is entered, and warn (never block) on a typo.
    const cardNumber = d.type === 3 && f.key === "number";
    const cardWarn = () => !!get() && !luhnValid(get());
    const shownWarn = cardNumber && cardWarn();
    const onchange = cardNumber
      ? () => {
          const brand = d.data.brand ? undefined : cardBrand(get());
          if (brand) d.data.brand = brand;
          if (brand || cardWarn() !== shownWarn) ctx.rerender();
        }
      : undefined;
    const below: Child[] = [];
    if (shownWarn) below.push(h("p", { class: "caption warn", role: "status" }, t("invalidCardNumber")));
    if (d.type === 1 && f.key === "username" && !get()) {
      const known = usernameSuggestions();
      if (known.length) below.push(h("div", { class: "chips scroll", role: "group", "aria-label": t("suggestions") }, ...known.map((u) => h("button", { type: "button", class: "chip", onclick: () => ((d.data.username = u), ctx.rerender()) }, u))));
    }
    const wrap = (block: HTMLElement) => (below.length ? h("div", { class: "field-block" }, block, ...below) : block);
    if (!f.secret) return wrap(field(id, f.icon, label(f.key), text(get, set, { autocomplete: "off", spellcheck: false, area: f.area })));
    const reveal = st.reveal.has(id);
    const control = text(get, set, { type: reveal ? "text" : "password", autocomplete: "new-password", spellcheck: false, class: "mono", onchange, inputMode: cardNumber ? "numeric" : undefined });
    const block = field(
      id,
      f.icon,
      label(f.key),
      control,
      h(
        "span",
        { class: "trailing" },
        iconButton(reveal ? "eyeOff" : "eye", t(reveal ? "hidePassword" : "showPassword"), () => {
          if (reveal) st.reveal.delete(id);
          else st.reveal.add(id);
          ctx.rerender();
        }),
        d.type === 1 && f.key === "password"
          ? iconButton("dice", t("generatePassword"), async () => {
              const r = await send<string>({ type: "generate", options: st.gen.type === "password" || st.gen.type === "passphrase" ? genOptions() : { ...GEN_DEFAULTS } }); // a PIN or username is no password
              if (!r.ok) return;
              d.data.password = r.data;
              st.reveal.add(id);
              ctx.rerender();
            })
          : null,
        d.type === 1 && f.key === "totp" && barcodeDetector()
          ? h(
              "label",
              { class: "icon-btn", title: t("scanQrImage") },
              icon("search"),
              h("span", { class: "sr-only" }, t("scanQrImage")),
              h("input", {
                type: "file",
                accept: "image/*",
                class: "sr-only",
                onchange: async (e: Event) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  const text = file ? await scanQr(file).catch(() => undefined) : undefined;
                  if (text?.startsWith("otpauth://")) d.data.totp = text;
                  else st.error = t(text ? "qrNotAuthenticator" : "qrNotFound");
                  ctx.rerender();
                },
              }),
            )
          : null,
      ),
    );
    return d.type === 1 && f.key === "password" ? h("div", { class: "field-block" }, block, strengthMeter(control, get())) : wrap(block);
  };

  const onsubmit = async (e: Event) => {
    e.preventDefault();
    if (!d.name.trim()) return ((st.error = t("nameRequired")), ctx.rerender());
    st.busy = true;
    st.error = undefined;
    ctx.rerender();
    const r = await send<VaultList>({ type: "saveItem", item: buildItem(d) });
    st.busy = false;
    if (!r.ok) return ((st.error = r.error), ctx.rerender());
    st.list = r.data;
    st.item = undefined;
    open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) });
    toast(ctx, t("saved"));
  };
  const typeChip = (type: number, ic: IconName) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(d.type === type), onclick: () => ((d.type = type), ctx.rerender()) }, icon(ic), t(TYPE_LABEL[type]!));
  const fav = h("input", { type: "checkbox", checked: d.favorite, "aria-label": t("favorite"), onchange: (e: Event) => (d.favorite = (e.target as HTMLInputElement).checked) });
  const customRow = (f: EditDraft["fields"][number], i: number) =>
    f.type === 3
      ? null // linked fields are kept as they are
      : h(
          "div",
          { class: "field-card" },
          h(
            "div",
            { class: "field-card-top" },
            h("input", {
              class: "name",
              placeholder: t("fieldName"),
              "aria-label": t("fieldName"),
              value: f.name,
              oninput: (e: Event) => (f.name = (e.target as HTMLInputElement).value),
            }),
            ...moveButtons(ctx, d.fields, i),
            iconButton("trash", t("removeField"), () => (d.fields.splice(i, 1), ctx.rerender()), { class: "icon-btn sm" }),
          ),
          h(
            "div",
            { class: "field-card-bottom" },
            f.type === 2
              ? select(
                  () => (f.value === "true" ? "true" : "false"),
                  (v) => (f.value = v),
                  [["false", t("no")], ["true", t("yes")]],
                )
              : h("input", {
                  placeholder: t("fieldValue"),
                  "aria-label": t("fieldValue"),
                  value: f.value,
                  type: f.type === 1 ? "password" : "text",
                  oninput: (e: Event) => (f.value = (e.target as HTMLInputElement).value),
                }),
            select(
              () => String(f.type),
              (v) => ((f.type = Number(v)), ctx.rerender()),
              [["0", t("fieldText")], ["1", t("fieldHidden")], ["2", t("fieldBoolean")]],
            ),
          ),
        );

  return h(
    "form",
    { class: "page editor", onsubmit },
    topBar(iconButton("back", t("cancel"), back), h("h1", {}, t(isNew ? "newItem" : "editItem")), spacer()),
    errorBox(),
    isNew ? h("div", { class: "chips", role: "group", "aria-label": t("itemType") }, typeChip(1, "key"), typeChip(3, "card"), typeChip(4, "user"), typeChip(2, "note"), typeChip(5, "key")) : null,
    field("edit-name", "edit", t("name"), text(() => d.name, (v) => (d.name = v), { required: true, "data-autofocus": "1" })),
    ...(SCHEMA[d.type]?.fields ?? []).map(specField),
    ...(d.type === 1 ? uriEditor(ctx) : []),
    d.type === 1 && settingsOf()?.autofillOnPageLoad
      ? field(
          "edit-auto-pageload",
          "timer",
          t("autofillOnPageLoad"),
          select(
            () => (d.autofillOnPageLoad === null ? "" : String(d.autofillOnPageLoad)),
            (v) => (d.autofillOnPageLoad = v === "" ? null : v === "true"),
            [["", t("defaultLabelWithValue", settingsOf()?.autofillOnPageLoadDefault === false ? t("off") : t("on"))], ["true", t("on")], ["false", t("off")]],
          ),
        )
      : null,
    sectionTitle(t("customFields")),
    ...d.fields.map(customRow),
    h("button", { type: "button", class: "btn text small add-field", onclick: () => (d.fields.push({ name: "", value: "", type: 0 }), ctx.rerender()) }, icon("plus"), t("addField")),
    field("edit-notes", "note", t("notes"), text(() => d.notes, (v) => (d.notes = v), { area: true, rows: 3 })),
    hasMarkup(d.notes)
      ? h("button", { type: "button", class: "chip small", "aria-pressed": String(st.notesPreview), onclick: () => ((st.notesPreview = !st.notesPreview), ctx.rerender()) }, t("previewNotes"))
      : null,
    st.notesPreview && hasMarkup(d.notes) ? renderMarkdown(d.notes) : null,
    field("edit-folder", "folder", t("folder"), select(() => d.folderId, (v) => (d.folderId = v), [["", t("noFolder")], ...(st.list?.folders ?? []).map((f): [string, string] => [f.id, f.name])])),
    h("label", { class: "row check-card" }, icon("star"), h("div", { class: "body" }, h("span", { class: "title" }, t("favorite"))), h("span", { class: "switch" }, fav, h("span"))),
    h(
      "label",
      { class: "row check-card" },
      icon("lock"),
      h("div", { class: "body" }, h("span", { class: "title" }, t("repromptToggle")), h("span", { class: "sub" }, t("repromptToggleHint"))),
      h("span", { class: "switch" }, h("input", { type: "checkbox", checked: d.reprompt, onchange: (e: Event) => (d.reprompt = (e.target as HTMLInputElement).checked) }), h("span")),
    ),
    st.busy ? progress() : null,
    h("div", { class: "editor-footer" }, h("button", { type: "submit", class: "btn filled wide", disabled: st.busy }, icon("check"), t("save"))),
  );
}

// ---------- folders ----------

function foldersView(ctx: Ctx): HTMLElement {
  const names = new Map((st.list?.folders ?? []).map((f) => [f.id, f.name]));
  const fresh = { name: "" };
  const folderRow = (id: string) =>
    h(
      "div",
      { class: "field-card" },
      h("div", { class: "field-card-top" }, h("input", { class: "name", value: names.get(id) ?? "", "aria-label": t("folderName"), oninput: (e: Event) => names.set(id, (e.target as HTMLInputElement).value) })),
      h(
        "div",
        { class: "field-card-bottom" },
        h("span", { class: "grow" }),
        iconButton("edit", t("rename"), () => void vaultAction(ctx, { type: "saveFolder", id, name: names.get(id) ?? "" }, "saved", false), { class: "icon-btn sm" }),
        iconButton("trash", t("deleteFolder"), () => void vaultAction(ctx, { type: "deleteFolder", id }, "deleted", false), { class: "icon-btn sm danger" }),
      ),
    );
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" })), h("h1", {}, t("folders"))),
    errorBox(),
    ...(st.list?.folders ?? []).map((f) => folderRow(f.id)),
    h(
      "form",
      {
        class: "field-card add",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (fresh.name.trim()) void vaultAction(ctx, { type: "saveFolder", name: fresh.name.trim() }, "saved", false);
        },
      },
      h(
        "div",
        { class: "field-card-bottom" },
        h("input", { placeholder: t("newFolder"), "aria-label": t("newFolder"), oninput: (e: Event) => (fresh.name = (e.target as HTMLInputElement).value) }),
        h("button", { type: "submit", class: "btn tonal small" }, t("add")),
      ),
    ),
  );
}

export function vaultScreen(ctx: Ctx): HTMLElement {
  currentCtx = ctx;
  closeMenu(); // a re-render invalidates any open popover menu
  if (!st.list && !st.loading && !st.error) void loadList(ctx);
  const r = st.route;
  if (st.large) return largeTypeView(ctx);
  if (st.qr) return qrView(ctx);
  if (r.kind === "item") return itemView(ctx, r.id);
  if (r.kind === "edit" && st.draft) return editView(ctx, r.isNew);
  if (r.kind === "folders") return foldersView(ctx);
  return listView(ctx);
}

// ---------- generator ----------

async function regenerate(ctx: Ctx) {
  const r = await send<string>({ type: "generate", options: genOptions() });
  st.generated = r.ok ? r.data : "";
  st.error = r.ok ? undefined : r.error;
  st.suggestions = [];
  ctx.rerender();
  if (!r.ok || st.gen.type !== "password") return;
  // Three ready-made variants next to the configured one: a short site-friendly one and two long ones.
  const variants = [{ length: 16, special: false }, { length: 24 }, { length: 32 }];
  const all = await Promise.all(variants.map((v) => send<string>({ type: "generate", options: { ...genOptions(), ...v } })));
  if (st.gen.type !== "password") return;
  st.suggestions = all.flatMap((x) => (x.ok ? [x.data] : []));
  ctx.rerender();
}

async function importWordlist(ctx: Ctx, file: File | undefined) {
  if (!file) return;
  const words = parseWordlist(await file.slice(0, 2 * 1024 * 1024).text());
  if (words.length < 100) return ((st.error = t("wordlistTooShort")), ctx.rerender());
  try {
    localStorage.setItem(WORDLIST_KEY, words.join("\n"));
  } catch {
    return ((st.error = t("wordlistNotSaved")), ctx.rerender());
  }
  st.error = undefined;
  void regenerate(ctx);
}

async function openHistory(ctx: Ctx) {
  const r = await send<HistoryEntry[]>({ type: "generatorHistory" });
  if (r.ok) st.history = r.data;
  else st.error = r.error;
  ctx.rerender();
}

function historyScreen(ctx: Ctx, list: HistoryEntry[]): HTMLElement {
  const close = () => ((st.history = undefined), ctx.rerender());
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), close), h("h1", { class: "grow" }, t("generatorHistory"))),
    list.length
      ? h(
          "div",
          { class: "group", role: "list" },
          ...list.map((e) =>
            h(
              "div",
              { class: "row", role: "listitem" },
              h("div", { class: "body" }, h("span", { class: "title mono" }, e.value), h("span", { class: "sub" }, new Date(e.date).toLocaleString())),
              iconButton("copy", t("copyField", e.value), () => void copy(ctx, e.value)),
            ),
          ),
        )
      : h("div", { class: "empty" }, icon("timer"), h("strong", {}, t("generatorHistoryEmpty"))),
    list.length
      ? h(
          "button",
          {
            type: "button",
            class: "btn text",
            onclick: async () => ((await send({ type: "generatorHistoryClear" })).ok ? ((st.history = []), ctx.rerender()) : undefined),
          },
          t("clear"),
        )
      : null,
    errorBox(),
  );
}

export function generatorScreen(ctx: Ctx): HTMLElement {
  if (st.history) return historyScreen(ctx, st.history);
  if (!st.generated && !st.error) void regenerate(ctx);
  const g = st.gen;
  const set = (k: string, v: unknown) => {
    g[k] = v;
    try {
      localStorage.setItem(GEN_KEY, JSON.stringify(g));
    } catch {
      /* no storage */
    }
    void regenerate(ctx);
  };
  const toggle = (k: string, label: string) =>
    h(
      "label",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      h("span", { class: "switch" }, h("input", { type: "checkbox", checked: g[k] === true, onchange: (e: Event) => set(k, (e.target as HTMLInputElement).checked) }), h("span")),
    );
  const slider = (k: string, label: string, min: number, max: number, suffix = "") => {
    const badge = h("span", { class: "value-badge" }, `${String(g[k])}${suffix}`);
    const input = h("input", { type: "range", min, max, value: String(g[k]), "aria-label": label });
    // The filled part of the track is a CSS gradient driven by --fill.
    const paint = (v: number) => {
      const ratio = max === min ? 0 : (v - min) / (max - min);
      input.style.setProperty("--fill", `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`);
    };
    paint(Number(g[k]));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      badge.textContent = `${v}${suffix}`;
      paint(v);
    });
    input.addEventListener("change", () => set(k, Number(input.value)));
    return h(
      "div",
      { class: "row slider-row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      input,
      badge,
    );
  };
  g.email ||= ctx.email() ?? "";
  const chip = (type: string, label: string, key = "type") => h("button", { type: "button", class: "chip", "aria-pressed": String(g[key] === type), onclick: () => set(key, type) }, label);
  const text = (k: string, label: string, props: Record<string, unknown> = {}) =>
    h(
      "label",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      h("input", { ...props, value: str(g[k]), "aria-label": label, spellcheck: false, onchange: (e: Event) => set(k, (e.target as HTMLInputElement).value) }),
    );
  const custom = g.type === "passphrase" && savedWordlist().length >= 100;
  let options: HTMLElement;
  if (g.type === "password")
    options = h(
      "div",
      { class: "group" },
      slider("length", t("length"), 5, 128),
      toggle("uppercase", "A–Z"),
      g.uppercase === true ? slider("minUppercase", t("minUppercase"), 0, 9) : null,
      toggle("lowercase", "a–z"),
      g.lowercase === true ? slider("minLowercase", t("minLowercase"), 0, 9) : null,
      toggle("numbers", "0–9"),
      toggle("special", "!@#$%^&*"),
      toggle("avoidAmbiguous", t("avoidAmbiguous")),
      g.numbers === true ? slider("minNumber", t("minDigits"), 0, 9) : null,
      g.special === true ? slider("minSpecial", t("minSymbols"), 0, 9) : null,
    );
  else if (g.type === "passphrase")
    options = h(
      "div",
      { class: "group" },
      slider("numWords", t("words"), 3, 20),
      text("wordSeparator", t("separator"), { class: "small-input", maxLength: 3 }),
      toggle("capitalize", t("capitalize")),
      toggle("includeNumber", t("includeNumber")),
      h(
        "div",
        { class: "row" },
        h("div", { class: "body" }, h("span", { class: "title" }, t("wordlist")), h("span", { class: "sub" }, custom ? t("wordlistCustom", String(savedWordlist().length)) : t("wordlistDefault"))),
        custom
          ? iconButton("close", t("wordlistReset"), () => {
              try {
                localStorage.removeItem(WORDLIST_KEY);
              } catch {
                /* no storage */
              }
              void regenerate(ctx);
            })
          : null,
        h("label", { class: "btn text small" }, t("wordlistImport"), h("input", { type: "file", class: "sr-only", accept: ".txt,.wordlist,text/plain", onchange: (e: Event) => void importWordlist(ctx, (e.target as HTMLInputElement).files?.[0]) })),
      ),
    );
  else if (g.type === "pin") options = h("div", { class: "group" }, slider("pinLength", t("length"), 3, 12));
  else
    options = h(
      "div",
      {},
      h("div", { class: "chips", role: "group", "aria-label": t("usernameType") }, chip("word", t("usernameWord"), "usernameType"), chip("plus", t("usernamePlus"), "usernameType"), chip("catchall", t("usernameCatchAll"), "usernameType"), chip("subdomain", t("usernameSubdomain"), "usernameType")),
      h(
        "div",
        { class: "group" },
        ...(g.usernameType === "plus" || g.usernameType === "subdomain"
          ? [text("email", t("email"), { type: "email" })]
          : g.usernameType === "catchall"
            ? [text("domain", t("domain"), { placeholder: "example.com" })]
            : [toggle("capitalize", t("capitalize")), toggle("includeNumber", t("includeNumber"))]),
      ),
    );
  return h(
    "div",
    { class: "page" },
    topBar(h("h1", { class: "grow" }, t("generator")), iconButton("timer", t("generatorHistory"), () => void openHistory(ctx))),
    h(
      "div",
      { class: "chips", role: "group", "aria-label": t("generator") },
      chip("password", t("typePassword")),
      chip("passphrase", t("typePassphrase")),
      chip("pin", t("typePin")),
      chip("username", t("username")),
    ),
    h(
      "div",
      { class: "generated" },
      h(
        "div",
        { class: "generated-row" },
        h(
          "output",
          { class: "mono", "aria-live": "polite", "aria-label": t("generatedValue") },
          ...(st.generated ? colorize(st.generated) : ["…"]),
        ),
        h(
          "div",
          { class: "trailing" },
          iconButton("refresh", t("regenerate"), () => void regenerate(ctx)),
          iconButton("copy", t("copyField", t("generatedValue")), () => {
            void copy(ctx, st.generated);
            void send({ type: "generatorHistoryAdd", value: st.generated });
          }),
        ),
      ),
      h("div", { class: "generated-foot" }, st.generated ? strengthBar(st.generated) : null, st.generated ? h("span", { class: "meter-label" }, strength(st.generated).label) : null),
    ),
    options,
    st.suggestions.length
      ? h(
          "div",
          {},
          sectionTitle(t("suggestions")),
          h("div", { class: "group", role: "list" }, ...st.suggestions.map((v, i) => h("div", { class: "row", role: "listitem" }, h("div", { class: "body" }, h("span", { class: "title mono ellipsis" }, ...colorize(v)), h("span", { class: "sub" }, t("characters", String(v.length)))), copyButton(ctx, `sug.${i}`, v, t("copyField", t("generatedValue")))))),
        )
      : null,
    st.generated
      ? actionRow("plus", t(g.type === "username" ? "createLoginWithUsername" : "createLoginWithPassword"), () => {
          ctx.goto("vault");
          startEdit(ctx, undefined, { data: { [g.type === "username" ? "username" : "password"]: st.generated } });
        })
      : null,
    errorBox(),
  );
}
