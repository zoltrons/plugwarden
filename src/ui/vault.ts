// Vault screens: list + search + folder filter, item view, Login/Note editor, generator.
// Talks to the service worker only; decrypted data lives here just while the popup is open.
import type { FillResult, PageLogin } from "../autofill/page.ts";
import type { HistoryEntry, PageMatches, VaultItem, VaultList } from "../shared/messages.ts";
import { type Child, h, send, t } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

type Json = Record<string, unknown>;
export interface Ctx {
  rerender(): void;
  lock(): void;
  /** The account email (default for plus-addressed usernames). */
  email(): string | undefined;
}

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
  uris: string;
  fields: { name: string; value: string; type: number; linkedId?: unknown }[];
}

const GEN_DEFAULTS: Json = {
  type: "password", length: 20, lowercase: true, uppercase: true, numbers: true, special: true, avoidAmbiguous: false,
  numWords: 5, wordSeparator: "-", capitalize: true, includeNumber: true,
  usernameType: "word", email: "", domain: "",
};

const st = {
  list: undefined as VaultList | undefined,
  page: undefined as PageMatches | undefined,
  loading: false,
  syncing: false,
  busy: false,
  error: undefined as string | undefined,
  route: { kind: "list" } as Route,
  query: "",
  folder: "",
  item: undefined as Json | undefined,
  reveal: new Set<string>(),
  totp: undefined as { code: string; remaining: number } | undefined,
  confirmDelete: false,
  draft: undefined as EditDraft | undefined,
  gen: { ...GEN_DEFAULTS },
  generated: "",
  /** Generator history screen, while open. */
  history: undefined as HistoryEntry[] | undefined,
  toast: "",
};
let totpTimer: ReturnType<typeof setInterval> | undefined;

export function resetVault(): void {
  clearInterval(totpTimer);
  Object.assign(st, {
    list: undefined, page: undefined, loading: false, syncing: false, busy: false, error: undefined, route: { kind: "list" }, query: "",
    folder: "", item: undefined, reveal: new Set(), totp: undefined, confirmDelete: false, draft: undefined,
    gen: { ...GEN_DEFAULTS }, generated: "", history: undefined, toast: "",
  });
}

// ---------- helpers ----------

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const humanize = (k: string) => k.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, (c) => c.toUpperCase());
/** Item-type sub-objects shown generically (editing them is a later phase). */
const TYPE_OBJECTS = ["card", "identity", "sshKey", "bankAccount", "driversLicense", "passport"];
const SECRET_KEYS = /password|code$|^number$|ssn|privateKey|accountNumber|licenseNumber|passportNumber|pin/i;

function hue(s: string): number {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

/** The server's icon service (`<server>/icons/<host>/icon.png`); unset when website icons are off. */
let iconBase: string | undefined;
export const setIconBase = (base: string | undefined) => (iconBase = base);

function iconUrl(uris: string[]): string | undefined {
  for (const u of iconBase ? uris : []) {
    try {
      const url = new URL(/^[a-z][\w+.-]*:/i.test(u) ? u : `https://${u}`);
      if (url.protocol === "https:" || url.protocol === "http:") return `${iconBase}/${url.hostname}/icon.png`;
    } catch {
      /* not a URL: try the next one */
    }
  }
  return undefined;
}

export function tile(name: string, type: number, uris: string[] = []): HTMLElement {
  const letter = name.trim().slice(0, 1).toUpperCase();
  const fallback: IconName = type === 2 ? "note" : type === 4 ? "user" : "key";
  const el = h("span", { class: "tile", style: `--h:${hue(name)}`, "aria-hidden": "true" }, letter || icon(fallback));
  const src = type === 1 ? iconUrl(uris) : undefined;
  if (src) el.replaceChildren(h("img", { src, alt: "", onerror: () => el.replaceChildren(letter || icon(fallback)) }));
  return el;
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

export async function copy(ctx: Ctx, value: string) {
  await navigator.clipboard.writeText(value);
  void send({ type: "clipboardCopied" }); // schedules clearing
  toast(ctx, t("copied"));
}

export function iconButton(ic: IconName, label: string, onclick: () => void, extra: Record<string, unknown> = {}) {
  return h("button", { type: "button", class: "icon-btn", "aria-label": label, title: label, onclick, ...extra }, icon(ic));
}

function errorBox(): Child {
  return st.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, st.error)) : null;
}

export function toastEl(): Child {
  return st.toast ? h("div", { class: "toast", role: "status" }, st.toast) : null;
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
  Object.assign(st, { route, error: undefined, confirmDelete: false, totp: undefined, reveal: new Set() });
  if (route.kind !== "edit") st.draft = undefined;
  ctx.rerender();
}

// ---------- list ----------

/** st.folder: "" all, "t:<type>", a folder id, "none" (no folder) or "trash" (the trash has its own list). */
function matches(i: VaultItem, q: string): boolean {
  const f = st.folder;
  if (f.startsWith("t:") ? i.type !== Number(f.slice(2)) : f === "none" ? i.folderId : f && f !== "trash" && i.folderId !== f) return false;
  if (!q) return true;
  return [i.name, i.sub, ...i.uris].some((s) => s.toLowerCase().includes(q));
}

function listView(ctx: Ctx): HTMLElement {
  if (st.folder === "trash" && st.list && !st.list.trash.length) st.folder = ""; // the trash was emptied
  const listBox = h("div", { class: "group", role: "list" });
  const fill = () => {
    const q = st.query.trim().toLowerCase();
    const items = ((st.folder === "trash" ? st.list?.trash : st.list?.items) ?? []).filter((i) => matches(i, q));
    // A–Z section letters (Keyguard style) while browsing; a plain list while searching.
    const letter = (i: VaultItem) => (/[a-z]/i.test(i.name[0] ?? "") ? i.name[0]!.toUpperCase() : "#");
    listBox.replaceChildren(
      ...items.flatMap((i, n) => [
        !q && (n === 0 || letter(items[n - 1]!) !== letter(i)) ? h("div", { class: "letter", role: "presentation" }, letter(i)) : null,
        h(
          "button",
          { type: "button", class: "row", role: "listitem", onclick: () => open(ctx, { kind: "item", id: i.id }) },
          tile(i.name, i.type, i.uris),
          h("div", { class: "body" }, h("span", { class: "title" }, i.failed ? t("decryptFailed") : i.name || t("untitled")), i.sub ? h("span", { class: "sub" }, i.sub) : null),
          i.favorite ? icon("star", t("favorite")) : null,
          icon("chevron"),
        ),
      ]).filter((x) => x !== null),
    );
    if (!items.length && st.list) listBox.replaceChildren(h("div", { class: "empty" }, icon("vault"), h("strong", {}, t(q || st.folder ? "noMatches" : "vaultEmpty"))));
  };
  fill();
  const search = h("input", {
    id: "vault-search",
    type: "search",
    placeholder: t("searchVault"),
    "aria-label": t("searchVault"),
    value: st.query,
    oninput: (e: Event) => {
      st.query = (e.target as HTMLInputElement).value;
      fill(); // list only, so the search box keeps focus and caret
    },
  });
  const folders = st.list?.folders ?? [];
  const chip = (id: string, label: string, ic?: IconName) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(st.folder === id), onclick: () => ((st.folder = st.folder === id ? "" : id), ctx.rerender()) }, ic ? icon(ic) : null, label);
  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "top" },
      h("div", { class: "search", style: "flex:1" }, icon("search"), search),
      iconButton("refresh", t("syncNow"), () => void syncNow(ctx, true), { class: `icon-btn${st.syncing ? " spin" : ""}`, disabled: st.syncing }),
      iconButton("lock", t("lockNow"), () => ctx.lock()),
    ),
    h(
      "div",
      { class: "chips scroll", role: "group", "aria-label": t("filters") },
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
    st.loading && !st.list ? h("div", { class: "progress" }) : listBox,
    h("button", { type: "button", class: "fab", onclick: () => startEdit(ctx, undefined) }, icon("plus"), t("newItem")),
  );
}

// ---------- this site ----------

async function fill(ctx: Ctx, id: string) {
  const r = await send<FillResult>({ type: "fill", id });
  if (r.ok && r.data.filled) window.close();
  else toast(ctx, r.ok ? t("fillFailed") : r.error);
}

/** Save what the user typed on the page: update the login with the same username, or create one. */
async function saveFromPage(ctx: Ctx) {
  const r = await send<PageLogin | null>({ type: "readPageLogin" });
  if (!r.ok || !r.data) return toast(ctx, r.ok ? t("noLoginOnPage") : r.error);
  const login = r.data;
  const same = st.page?.items.find((i) => !i.readOnly && i.sub === login.username);
  if (same) {
    const item = await send<Json>({ type: "getItem", id: same.id });
    if (item.ok) return startEdit(ctx, item.data, { data: { password: login.password } });
  }
  const url = new URL(login.url);
  startEdit(ctx, undefined, { name: url.hostname, data: { username: login.username, password: login.password }, uris: url.origin });
}

function suggestions(ctx: Ctx): Child {
  const page = st.page;
  if (!page?.host) return null;
  return h(
    "section",
    { class: "suggestions", "aria-label": t("onThisSite", page.host) },
    h("h2", { class: "section-title" }, t("onThisSite", page.host)),
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
              h("button", { type: "button", class: "btn tonal small", "aria-label": `${t("fill")} ${i.name}`, onclick: () => void fill(ctx, i.id) }, t("fill")),
            ),
          ),
        )
      : null,
    h("button", { type: "button", class: "btn text", onclick: () => void saveFromPage(ctx) }, icon("plus"), t("saveFromPage")),
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
const TYPE_LABEL: Record<number, string> = { 1: "typeLogin", 2: "typeNote", 3: "typeCard", 4: "typeIdentity", 5: "typeSshKey" };
const label = (key: string) => t(`field_${key}`);

/** Rough strength from length and character classes (no dictionary check). */
function strength(pw: string): { label: string; level: number } {
  const pool = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].reduce((n, re, i) => n + (re.test(pw) ? [26, 26, 10, 33][i]! : 0), 0);
  const bits = pw.length * Math.log2(Math.max(pool, 2));
  const level = bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : 3;
  return { level, label: t(["strengthWeak", "strengthFair", "strengthStrong", "strengthVeryStrong"][level]!) };
}

// ---------- item view ----------

function fieldRow(ctx: Ctx, key: string, ic: IconName, title: string, value: string, opts: { secret?: boolean; mono?: boolean; extra?: Child } = {}): HTMLElement {
  const shown = !opts.secret || st.reveal.has(key);
  return h(
    "div",
    { class: "row field-row" },
    icon(ic),
    h(
      "div",
      { class: "body" },
      h("span", { class: "label" }, title),
      h("span", { class: `value${opts.mono ? " mono" : ""}` }, shown ? value : "•".repeat(Math.min(value.length, 12))),
      opts.extra,
    ),
    opts.secret
      ? iconButton(shown ? "eyeOff" : "eye", t(shown ? "hidePassword" : "showPassword"), () => {
          if (shown) st.reveal.delete(key);
          else st.reveal.add(key);
          ctx.rerender();
        })
      : null,
    iconButton("copy", t("copyField", title), () => void copy(ctx, value)),
  );
}

function totpRow(ctx: Ctx, id: string): HTMLElement {
  if (!st.totp) {
    void refreshTotp(ctx, id);
    return h("div", { class: "row" }, icon("timer"), h("div", { class: "body" }, h("span", { class: "label" }, t("oneTimeCode")), h("span", { class: "value" }, "…")));
  }
  const { code, remaining } = st.totp;
  const pretty = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  return h(
    "div",
    { class: "row field-row" },
    icon("timer"),
    h("div", { class: "body" }, h("span", { class: "label" }, t("oneTimeCode")), h("span", { class: "value mono totp", "data-totp": "1" }, pretty)),
    h("span", { class: "countdown", "data-remaining": "1", "aria-label": t("secondsLeft", String(remaining)) }, String(remaining)),
    iconButton("copy", t("copyField", t("oneTimeCode")), () => void copy(ctx, code)),
  );
}

async function refreshTotp(ctx: Ctx, id: string) {
  const r = await send<{ code: string; remaining: number }>({ type: "totp", id });
  if (!r.ok || st.route.kind !== "item" || st.route.id !== id) return;
  st.totp = { code: r.data.code, remaining: r.data.remaining };
  ctx.rerender();
  clearInterval(totpTimer);
  totpTimer = setInterval(() => {
    if (!st.totp) return;
    st.totp.remaining -= 1;
    const pill = document.querySelector<HTMLElement>("[data-remaining]");
    if (st.totp.remaining <= 0) {
      clearInterval(totpTimer);
      void refreshTotp(ctx, id);
    } else if (pill) pill.textContent = String(st.totp.remaining); // tick without a full re-render
  }, 1000);
}

function section(title: string, ...rows: Child[]): Child[] {
  const present = rows.filter(Boolean);
  return present.length ? [h("h2", { class: "section-title" }, title), h("div", { class: "group" }, ...present)] : [];
}

const actionRow = (ic: IconName, title: string, onclick: () => void, danger = false) =>
  h("button", { type: "button", class: `row${danger ? " danger" : ""}`, disabled: st.busy, onclick }, icon(ic), h("div", { class: "body" }, h("span", { class: "title" }, title)));

async function vaultAction(ctx: Ctx, req: Parameters<typeof send>[0], done: string, back = true) {
  st.busy = true;
  ctx.rerender();
  const r = await send<VaultList>(req);
  st.busy = false;
  st.confirmDelete = false;
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  st.list = r.data;
  st.item = undefined;
  if (back) open(ctx, { kind: "list" });
  else ctx.rerender();
  toast(ctx, t(done));
}

// Same cap as Send files (MAX_SEND_FILE_BYTES in background/vault.ts).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

async function download(ctx: Ctx, cipherId: string, attachmentId: string) {
  const r = await send<{ fileName: string; data: string }>({ type: "downloadAttachment", cipherId, attachmentId });
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  const url = URL.createObjectURL(new Blob([Uint8Array.fromBase64(r.data.data)]));
  h("a", { href: url, download: r.data.fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function upload(ctx: Ctx, cipherId: string, file: File | undefined) {
  if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) return ((st.error = t("fileTooLarge")), ctx.rerender());
  const data = new Uint8Array(await file.arrayBuffer()).toBase64();
  await vaultAction(ctx, { type: "addAttachment", cipherId, file: { name: file.name, data } }, "saved", false);
}

function itemView(ctx: Ctx, id: string): HTMLElement {
  const item = st.item && st.item.id === id ? st.item : undefined;
  if (!item) {
    void send<Json>({ type: "getItem", id }).then((r) => {
      if (r.ok) st.item = r.data;
      else st.error = r.error;
      ctx.rerender();
    });
    return h("div", { class: "page" }, h("div", { class: "top" }, iconButton("back", t("back"), () => open(ctx, { kind: "list" }))), errorBox(), st.error ? null : h("div", { class: "progress" }));
  }
  const inTrash = !!item.deletedDate;
  const summary = [...(st.list?.items ?? []), ...(st.list?.trash ?? [])].find((i) => i.id === id);
  const type = Number(item.type);
  const editable = !summary?.readOnly && !inTrash && type >= 1 && type <= 4;
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
    rows.push(fieldRow(ctx, f.key, f.icon, label(f.key), v, { secret: f.secret, mono: f.mono, extra: s ? h("span", { class: `pill s${s.level}` }, s.label) : null }));
  }
  const login = type === 1 ? data : undefined;
  const uris = (Array.isArray(login?.uris) ? (login!.uris as Json[]) : []).map((u) => str(u.uri)).filter(Boolean);
  const fields = Array.isArray(item.fields) ? (item.fields as Json[]) : [];
  const history = Array.isArray(item.passwordHistory) ? (item.passwordHistory as Json[]) : [];
  const folder = st.list?.folders.find((f) => f.id === item.folderId);
  const attachments = Array.isArray(item.attachments) ? (item.attachments as Json[]) : [];
  const org = st.list?.organizations?.find((o) => o.id === item.organizationId);
  const collections = (Array.isArray(item.collectionIds) ? (item.collectionIds as string[]) : []).map((c) => st.list?.collections?.find((x) => x.id === c)?.name).filter(Boolean);
  const date = (v: unknown) => (typeof v === "string" && v ? new Date(v).toLocaleString() : "");
  const passkeys = Array.isArray(login?.fido2Credentials) ? (login!.fido2Credentials as Json[]).length : 0;
  const confirm = (fn: () => void) => () => (st.confirmDelete ? fn() : ((st.confirmDelete = true), ctx.rerender()));

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "top" },
      iconButton("back", t("back"), () => open(ctx, { kind: "list" })),
      h("span", { style: "flex:1" }),
      editable
        ? iconButton("star", t(item.favorite ? "unfavorite" : "favorite"), () => void vaultAction(ctx, { type: "saveItem", item: { ...item, favorite: !item.favorite } }, "saved", false), {
            class: `icon-btn${item.favorite ? " on" : ""}`,
            "aria-pressed": String(item.favorite === true),
          })
        : null,
      editable ? iconButton("edit", t("edit"), () => startEdit(ctx, item)) : null,
    ),
    h("div", { class: "hero" }, tile(str(item.name), type, uris), h("div", { class: "body" }, h("h1", {}, str(item.name) || t("untitled")), h("span", { class: "sub" }, t(TYPE_LABEL[type] ?? "untitled")))),
    errorBox(),
    inTrash ? h("div", { class: "notice warn" }, icon("trash"), h("div", {}, t("inTrash"))) : summary?.readOnly ? h("div", { class: "notice" }, icon("lock"), h("div", {}, t("readOnlyItem"))) : null,
    rows.length ? h("div", { class: "group" }, ...rows) : null,
    login?.passwordRevisionDate ? h("p", { class: "caption" }, t("passwordChanged", date(login.passwordRevisionDate))) : null,
    passkeys ? h("div", { class: "notice info" }, icon("key"), h("div", {}, t("passkeyAvailable"))) : null,
    ...section(t("websites"), ...uris.map((u) => h("a", { class: "row", href: /^https?:\/\//i.test(u) ? u : `https://${u}`, target: "_blank", rel: "noopener noreferrer" }, icon("globe"), h("div", { class: "body" }, h("span", { class: "title ellipsis" }, u))))),
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
    ...(str(item.notes) ? [h("h2", { class: "section-title" }, t("notes")), h("div", { class: "notes" }, str(item.notes))] : []),
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
        ? actionRow("trash", t(st.confirmDelete ? "confirmPurge" : "deleteForever"), confirm(() => void vaultAction(ctx, { type: "purgeItem", id }, "deleted")), true)
        : editable
          ? actionRow("trash", t(st.confirmDelete ? "confirmTrash" : "moveToTrash"), confirm(() => void vaultAction(ctx, { type: "deleteItem", id }, "movedToTrash")), true)
          : null,
    ),
  );
}

// ---------- editor (Login, Secure note, Card, Identity) ----------

interface Prefill {
  name?: string;
  uris?: string;
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
    uris: prefill.uris ?? (Array.isArray(login?.uris) ? (login!.uris as Json[]) : []).map((u) => str(u.uri)).filter(Boolean).join("\n"),
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
      const oldUris = Array.isArray(typed.uris) ? (typed.uris as Json[]) : [];
      typed.uris = d.uris.split("\n").map((u) => u.trim()).filter(Boolean).map((u) => oldUris.find((o) => o.uri === u) ?? { uri: u, match: null });
    }
    item[schema.obj] = typed;
  } else item.secureNote = obj(d.base.secureNote) ?? { type: 0 };
  item.fields = d.fields
    .filter((f) => f.name.trim() || f.value)
    .map((f) => ({ name: f.name, value: f.type === 2 ? String(f.value === "true") : f.value || null, type: f.type, linkedId: f.linkedId ?? null }));
  return item;
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
    h("select", { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...options.map(([v, l]) => h("option", { value: v, selected: v === get() }, l)));

  const specField = (f: Spec) => {
    const get = () => d.data[f.key] ?? "";
    const set = (v: string) => (d.data[f.key] = v);
    const id = `edit-${f.key}`;
    if (f.options) return field(id, f.icon, label(f.key), select(get, set, [["", "—"], ...f.options.map((o): [string, string] => [o, o])]));
    if (!f.secret) return field(id, f.icon, label(f.key), text(get, set, { autocomplete: "off", spellcheck: false, area: f.area }));
    const reveal = st.reveal.has(id);
    return field(
      id,
      f.icon,
      label(f.key),
      text(get, set, { type: reveal ? "text" : "password", autocomplete: "new-password", spellcheck: false, class: "mono" }),
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
          { class: "custom-field" },
          text(() => f.name, (v) => (f.name = v), { placeholder: t("fieldName"), "aria-label": t("fieldName") }),
          f.type === 2
            ? select(() => (f.value === "true" ? "true" : "false"), (v) => (f.value = v), [["false", t("no")], ["true", t("yes")]])
            : text(() => f.value, (v) => (f.value = v), { placeholder: t("fieldValue"), "aria-label": t("fieldValue"), type: f.type === 1 ? "password" : "text" }),
          select(() => String(f.type), (v) => ((f.type = Number(v)), ctx.rerender()), [["0", t("fieldText")], ["1", t("fieldHidden")], ["2", t("fieldBoolean")]]),
          iconButton("trash", t("removeField"), () => (d.fields.splice(i, 1), ctx.rerender())),
        );

  return h(
    "form",
    { class: "page", onsubmit },
    h("div", { class: "top" }, iconButton("back", t("cancel"), back), h("h1", {}, t(isNew ? "newItem" : "editItem"))),
    isNew ? h("div", { class: "chips", role: "group", "aria-label": t("itemType") }, typeChip(1, "key"), typeChip(3, "card"), typeChip(4, "user"), typeChip(2, "note")) : null,
    field("edit-name", "edit", t("name"), text(() => d.name, (v) => (d.name = v), { required: true, "data-autofocus": "1" })),
    ...(SCHEMA[d.type]?.fields ?? []).map(specField),
    d.type === 1 ? field("edit-uris", "globe", t("websitesOnePerLine"), text(() => d.uris, (v) => (d.uris = v), { area: true, rows: 2 })) : null,
    h("h2", { class: "section-title" }, t("customFields")),
    ...d.fields.map(customRow),
    h("button", { type: "button", class: "btn text", onclick: () => (d.fields.push({ name: "", value: "", type: 0 }), ctx.rerender()) }, icon("plus"), t("addField")),
    field("edit-notes", "note", t("notes"), text(() => d.notes, (v) => (d.notes = v), { area: true, rows: 3 })),
    field("edit-folder", "folder", t("folder"), select(() => d.folderId, (v) => (d.folderId = v), [["", t("noFolder")], ...(st.list?.folders ?? []).map((f): [string, string] => [f.id, f.name])])),
    h("label", { class: "check" }, h("div", { class: "body" }, t("favorite")), h("span", { class: "switch" }, fav, h("span"))),
    errorBox(),
    st.busy ? h("div", { class: "progress" }) : null,
    h("button", { type: "submit", class: "btn filled wide", disabled: st.busy }, t("save")),
  );
}

// ---------- folders ----------

function foldersView(ctx: Ctx): HTMLElement {
  const names = new Map((st.list?.folders ?? []).map((f) => [f.id, f.name]));
  const fresh = { name: "" };
  const folderRow = (id: string) =>
    h(
      "div",
      { class: "custom-field" },
      h("input", { value: names.get(id) ?? "", "aria-label": t("folderName"), oninput: (e: Event) => names.set(id, (e.target as HTMLInputElement).value) }),
      iconButton("edit", t("rename"), () => void vaultAction(ctx, { type: "saveFolder", id, name: names.get(id) ?? "" }, "saved", false)),
      iconButton("trash", t("deleteFolder"), () => void vaultAction(ctx, { type: "deleteFolder", id }, "deleted", false)),
    );
  return h(
    "div",
    { class: "page" },
    h("div", { class: "top" }, iconButton("back", t("back"), () => open(ctx, { kind: "list" })), h("h1", {}, t("folders"))),
    errorBox(),
    ...(st.list?.folders ?? []).map((f) => folderRow(f.id)),
    h(
      "form",
      {
        class: "custom-field",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (fresh.name.trim()) void vaultAction(ctx, { type: "saveFolder", name: fresh.name.trim() }, "saved", false);
        },
      },
      h("input", { placeholder: t("newFolder"), "aria-label": t("newFolder"), oninput: (e: Event) => (fresh.name = (e.target as HTMLInputElement).value) }),
      h("button", { type: "submit", class: "btn tonal small" }, t("add")),
    ),
  );
}

export function vaultScreen(ctx: Ctx): HTMLElement {
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
    h("div", { class: "top" }, iconButton("back", t("back"), close), h("h1", { style: "flex:1" }, t("generatorHistory"))),
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
      ? h("button", { type: "button", class: "btn text", onclick: async () => ((await send({ type: "generatorHistoryClear" })).ok ? ((st.history = []), ctx.rerender()) : undefined) }, t("clear"))
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
  const range = (k: string, label: string, min: number, max: number) =>
    h(
      "label",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, `${label}: ${String(g[k])}`)),
      h("input", { type: "range", min, max, value: String(g[k]), "aria-label": label, onchange: (e: Event) => set(k, Number((e.target as HTMLInputElement).value)) }),
    );
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
    options = h("div", { class: "group" }, range("length", t("length"), 5, 128), toggle("uppercase", "A–Z"), toggle("lowercase", "a–z"), toggle("numbers", "0–9"), toggle("special", "!@#$%^&*"), toggle("avoidAmbiguous", t("avoidAmbiguous")));
  else if (g.type === "passphrase")
    options = h(
      "div",
      { class: "group" },
      range("numWords", t("words"), 3, 20),
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
    h("div", { class: "top" }, h("h1", { style: "flex:1" }, t("generator")), iconButton("timer", t("generatorHistory"), () => void openHistory(ctx))),
    h(
      "div",
      { class: "generated" },
      h(
        "output",
        { class: "mono", "aria-live": "polite", "aria-label": t("generatedValue") },
        ...(st.generated ? [...st.generated].map((c) => (/\d/.test(c) ? h("span", { class: "d" }, c) : /[^\p{L}\s-]/u.test(c) ? h("span", { class: "s" }, c) : c)) : ["…"]),
      ),
      h("div", { class: "trailing" }, iconButton("refresh", t("regenerate"), () => void regenerate(ctx)), iconButton("copy", t("copyField", t("generatedValue")), () => {
        void copy(ctx, st.generated);
        void send({ type: "generatorHistoryAdd", value: st.generated });
      })),
    ),
    h("div", { class: "chips" }, chip("password", t("typePassword")), chip("passphrase", t("typePassphrase")), chip("username", t("username"))),
    options,
    errorBox(),
  );
}
