// Vault screens: list (search, filters, sort), item view, Login/Note/Card/Identity editor, generator.
// Talks to the service worker only; decrypted data lives here just while the popup is open.
import type { FillResult, PageLogin } from "../autofill/page.ts";
import { URI_MATCH, URI_MATCH_ADVANCED } from "../shared/constants.ts";
import type { HistoryEntry, PageMatches, Settings, VaultItem, VaultList } from "../shared/messages.ts";
import { type Child, h, send, t, withChevron } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

type Json = Record<string, unknown>;
export interface Ctx {
  rerender(): void;
  lock(): void;
  /** The account email (default for plus-addressed usernames). */
  email(): string | undefined;
  /** Current settings (per-item options depend on the account-level ones). */
  settings(): Settings | undefined;
}

type Sort = "name" | "nameDesc" | "updated" | "created";
type Route = { kind: "list" } | { kind: "item"; id: string } | { kind: "edit"; isNew: boolean } | { kind: "folders" };

interface EditDraft {
  base: Json;
  type: number;
  name: string;
  notes: string;
  folderId: string;
  favorite: boolean;
  /** Type-specific fields (SCHEMA) by key. */
  data: Record<string, string>;
  /** Login websites with their own match strategy (null = the account default). */
  uris: { uri: string; match: number | null }[];
  /** Tri-state "Autofill on page load" (null = the account default). */
  autofillOnPageLoad: boolean | null;
  fields: { name: string; value: string; type: number; linkedId?: unknown }[];
}

const GEN_DEFAULTS: Json = {
  type: "password", length: 20, lowercase: true, uppercase: true, numbers: true, special: true, avoidAmbiguous: false,
  numWords: 5, wordSeparator: "-", capitalize: true, includeNumber: true,
  usernameType: "word", email: "", domain: "",
};

const SORT_KEY = "vaultSort";
const SORTS: { id: Sort; label: string }[] = [
  { id: "name", label: "sortNameAsc" },
  { id: "nameDesc", label: "sortNameDesc" },
  { id: "updated", label: "sortUpdated" },
  { id: "created", label: "sortCreated" },
];

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
  gen: { ...GEN_DEFAULTS },
  generated: "",
  /** Generator history screen, while open. */
  history: undefined as HistoryEntry[] | undefined,
  toast: "",
  /** Key of the field/row that was copied last (shows a check instead of the copy icon). */
  copied: "",
  /** The search box was focused once for this session; later renders keep the user's focus. */
  sawList: false,
  /** Editor: URI rows whose match-detection select is open, by index. */
  uriOpen: new Set<number>(),
};
let totpTimer: ReturnType<typeof setInterval> | undefined;

export function resetVault(): void {
  clearInterval(totpTimer);
  closeMenu();
  Object.assign(st, {
    list: undefined, page: undefined, loading: false, syncing: false, busy: false, error: undefined, route: { kind: "list" }, query: "",
    folder: "", item: undefined, reveal: new Set(), totp: undefined, confirmDelete: 0, draft: undefined,
    gen: { ...GEN_DEFAULTS }, generated: "", history: undefined, toast: "", copied: "", sawList: false, uriOpen: new Set(),
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
  Object.assign(st, { route, error: undefined, confirmDelete: 0, totp: undefined, reveal: new Set(), copied: "", uriOpen: new Set(), repromptFor: undefined, itemFailedFor: undefined });
  if (route.kind !== "edit") st.draft = undefined;
  ctx.rerender();
}

// ---------- list ----------

const TYPE_LABEL: Record<number, string> = { 1: "typeLogin", 2: "typeNote", 3: "typeCard", 4: "typeIdentity", 5: "typeSshKey" };

function matches(i: VaultItem, q: string): boolean {
  const f = st.folder;
  if (f === "fav") {
    if (!i.favorite) return false;
  } else if (f.startsWith("t:")) {
    if (i.type !== Number(f.slice(2))) return false;
  } else if (f === "none") {
    if (i.folderId) return false;
  } else if (f && f !== "trash" && i.folderId !== f) return false;
  if (!q) return true;
  return [i.name, i.sub, ...i.uris].some((s) => s.toLowerCase().includes(q));
}

function sortItems(items: VaultItem[]): VaultItem[] {
  const byName = (a: VaultItem, b: VaultItem) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const list = [...items];
  if (st.sort === "nameDesc") return list.sort((a, b) => byName(b, a));
  if (st.sort === "updated") return list.sort((a, b) => (b.revisionDate ?? 0) - (a.revisionDate ?? 0) || byName(a, b));
  if (st.sort === "created") return list.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0) || byName(a, b));
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
    const items = sortItems((source ?? []).filter((i) => matches(i, q)));
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

/** A flagged item opens its master-password screen instead of failing. */
function askReprompt(ctx: Ctx, id: string) {
  open(ctx, { kind: "item", id });
  st.repromptFor = id;
  ctx.rerender();
}

async function fill(ctx: Ctx, id: string) {
  const r = await send<FillResult>({ type: "fill", id });
  if (r.ok && r.data.filled) window.close();
  else if (!r.ok && r.code === "reprompt") askReprompt(ctx, id);
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
    if (item.code === "reprompt") return askReprompt(ctx, same.id); // never fall through to a duplicate
  }
  const url = new URL(login.url);
  startEdit(ctx, undefined, { name: url.hostname, data: { username: login.username, password: login.password }, uris: [{ uri: url.origin, match: null }] });
}

function suggestions(ctx: Ctx): Child {
  const page = st.page;
  if (!page?.host) return null;
  return h(
    "section",
    { class: "suggestions", "aria-label": t("onThisSite", page.host) },
    h("div", { class: "suggestions-head" }, h("h2", { class: "section-title" }, t("onThisSite", page.host))),
    page.items.length
      ? h(
          "div",
          { class: "group" },
          ...page.items.map((i) =>
            h(
              "div",
              { class: "row" },
              tile(i.name, i.type, i.uris),
              h("div", { class: "body" }, h("span", { class: "title" }, i.name), i.sub ? h("span", { class: "sub" }, i.sub) : null),
              h("button", { type: "button", class: "btn tonal small", "aria-label": `${t("fill")} ${i.name}`, onclick: () => void fill(ctx, i.id) }, icon("key"), t("fill")),
            ),
          ),
        )
      : null,
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

/** Rough strength from length and character classes (no dictionary check). */
function strength(pw: string): { label: string; level: number } {
  const pool = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].reduce((n, re, i) => n + (re.test(pw) ? [26, 26, 10, 33][i]! : 0), 0);
  const bits = pw.length * Math.log2(Math.max(pool, 2));
  const level = bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : 3;
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
  opts: { secret?: boolean; mono?: boolean; extra?: Child } = {},
): HTMLElement {
  const shown = !opts.secret || st.reveal.has(key);
  const valueEl = h("span", { class: `value${opts.mono ? " mono" : ""}` });
  if (shown) {
    if (opts.mono && opts.secret) valueEl.append(...colorize(value));
    else valueEl.textContent = value;
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
      copyButton(ctx, key, value, t("copyField", title)),
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

function totpRow(ctx: Ctx, id: string): HTMLElement {
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
    ),
  );
}

async function refreshTotp(ctx: Ctx, id: string) {
  const r = await send<{ code: string; period: number; remaining: number }>({ type: "totp", id });
  if (st.route.kind !== "item" || st.route.id !== id) return;
  if (!r.ok) {
    // The re-prompt grant ran out: hide the item again until the password is re-entered.
    if (r.code === "reprompt") Object.assign(st, { item: undefined, totp: undefined, repromptFor: id });
    return ctx.rerender();
  }
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
  const onSite = st.page?.items.some((i) => i.id === id);
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
  const inTrash = !!item.deletedDate;
  const summary = [...(st.list?.items ?? []), ...(st.list?.trash ?? [])].find((i) => i.id === id);
  const type = Number(item.type);
  const editable = !summary?.readOnly && !inTrash && type >= 1 && type <= 5;
  const schema = SCHEMA[type];
  const data = schema ? (obj(item[schema.obj]) ?? {}) : {};
  const rows: Child[] = [];
  for (const f of schema?.fields ?? []) {
    const v = str(data[f.key]);
    if (!v) continue;
    if (type === 1 && f.key === "totp") {
      rows.push(totpRow(ctx, id));
      continue;
    }
    const s = type === 1 && f.key === "password" ? strength(v) : undefined;
    rows.push(fieldRow(ctx, f.key, f.icon, label(f.key), v, { secret: f.secret, mono: f.mono, extra: s ? h("span", { class: `badge s${s.level}` }, s.label) : null }));
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

  return h(
    "div",
    { class: "page item-page" },
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
    login?.passwordRevisionDate ? h("p", { class: "caption" }, t("passwordChanged", date(login.passwordRevisionDate))) : null,
    passkeys ? h("div", { class: "notice info" }, icon("key"), h("div", {}, t("passkeyAvailable"))) : null,
    ...section(
      t("websites"),
      ...uriEntries.map(({ uri: u, match }) => {
        const href = webUrl(u);
        const body = h("div", { class: "body" }, h("span", { class: "title ellipsis" }, u), match !== null ? h("span", { class: "sub" }, uriMatchLabel(match)) : null);
        return href
          ? h(
              "a",
              {
                class: "row",
                href,
                target: "_blank",
                rel: "noopener noreferrer",
                onclick: (e: Event) => {
                  e.preventDefault();
                  void chrome.tabs.create({ url: href });
                },
              },
              icon("globe"),
              body,
              icon("external"),
            )
          : h("div", { class: "row" }, icon("globe"), body);
      }),
    ),
    ...section(
      t("customFields"),
      ...fields.map((f, i) =>
        Number(f.type) === 3
          ? null
          : Number(f.type) === 2
            ? h("div", { class: "row" }, icon("note"), h("div", { class: "body" }, h("span", { class: "label" }, str(f.name)), h("span", { class: "value" }, t(str(f.value) === "true" ? "yes" : "no"))))
            : fieldRow(ctx, `field.${i}`, "note", str(f.name) || t("untitled"), str(f.value), { secret: Number(f.type) === 1 }),
      ),
    ),
    ...(str(item.notes) ? [sectionTitle(t("notes")), h("div", { class: "notes" }, str(item.notes))] : []),
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
  const item: Json = { ...d.base, type: d.type, name: d.name.trim(), notes: orNull(d.notes), folderId: d.folderId || null, favorite: d.favorite };
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

function editView(ctx: Ctx, isNew: boolean): HTMLElement {
  const d = st.draft!;
  const back = () => open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) });
  const field = (id: string, ic: IconName, title: string, control: HTMLElement, trailing?: Child) => {
    control.id = id;
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
    if (!f.secret) return field(id, f.icon, label(f.key), text(get, set, { autocomplete: "off", spellcheck: false, area: f.area }));
    const reveal = st.reveal.has(id);
    const control = text(get, set, { type: reveal ? "text" : "password", autocomplete: "new-password", spellcheck: false, class: "mono" });
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
              const r = await send<string>({ type: "generate", options: st.gen });
              if (!r.ok) return;
              d.data.password = r.data;
              st.reveal.add(id);
              ctx.rerender();
            })
          : null,
      ),
    );
    return d.type === 1 && f.key === "password" ? h("div", { class: "field-block" }, block, strengthMeter(control, get())) : block;
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
    field("edit-folder", "folder", t("folder"), select(() => d.folderId, (v) => (d.folderId = v), [["", t("noFolder")], ...(st.list?.folders ?? []).map((f): [string, string] => [f.id, f.name])])),
    h("label", { class: "row check-card" }, icon("star"), h("div", { class: "body" }, h("span", { class: "title" }, t("favorite"))), h("span", { class: "switch" }, fav, h("span"))),
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
  if (r.kind === "item") return itemView(ctx, r.id);
  if (r.kind === "edit" && st.draft) return editView(ctx, r.isNew);
  if (r.kind === "folders") return foldersView(ctx);
  return listView(ctx);
}

// ---------- generator ----------

async function regenerate(ctx: Ctx) {
  const r = await send<string>({ type: "generate", options: st.gen });
  st.generated = r.ok ? r.data : "";
  st.error = r.ok ? undefined : r.error;
  ctx.rerender();
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
    return h(
      "div",
      { class: "row slider-row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      badge,
      h(
        "input",
        {
          type: "range",
          min,
          max,
          value: String(g[k]),
          "aria-label": label,
          oninput: (e: Event) => (badge.textContent = `${(e.target as HTMLInputElement).value}${suffix}`),
          onchange: (e: Event) => set(k, Number((e.target as HTMLInputElement).value)),
        },
      ),
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
  let options: HTMLElement;
  if (g.type === "password")
    options = h(
      "div",
      { class: "group" },
      slider("length", t("length"), 5, 128),
      toggle("uppercase", "A–Z"),
      toggle("lowercase", "a–z"),
      toggle("numbers", "0–9"),
      toggle("special", "!@#$%^&*"),
      toggle("avoidAmbiguous", t("avoidAmbiguous")),
    );
  else if (g.type === "passphrase")
    options = h(
      "div",
      { class: "group" },
      slider("numWords", t("words"), 3, 20),
      text("wordSeparator", t("separator"), { class: "small-input", maxLength: 3 }),
      toggle("capitalize", t("capitalize")),
      toggle("includeNumber", t("includeNumber")),
    );
  else
    options = h(
      "div",
      {},
      h("div", { class: "chips", role: "group", "aria-label": t("usernameType") }, chip("word", t("usernameWord"), "usernameType"), chip("plus", t("usernamePlus"), "usernameType"), chip("catchall", t("usernameCatchAll"), "usernameType")),
      h(
        "div",
        { class: "group" },
        ...(g.usernameType === "plus"
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
    errorBox(),
  );
}
