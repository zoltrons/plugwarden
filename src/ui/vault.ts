// Vault screens: list + search + folder filter, item view, Login/Note editor, generator.
// Talks to the service worker only; decrypted data lives here just while the popup is open.
import type { FillResult, PageLogin } from "../autofill/page.ts";
import type { PageMatches, VaultItem, VaultList } from "../shared/messages.ts";
import { type Child, h, send, t } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

type Json = Record<string, unknown>;
export interface Ctx {
  rerender(): void;
  lock(): void;
}

type Route = { kind: "list" } | { kind: "item"; id: string } | { kind: "edit"; isNew: boolean };

interface EditDraft {
  base: Json;
  type: 1 | 2;
  name: string;
  username: string;
  password: string;
  totp: string;
  uris: string;
  notes: string;
  folderId: string;
  favorite: boolean;
}

const GEN_DEFAULTS: Json = {
  type: "password", length: 20, lowercase: true, uppercase: true, numbers: true, special: true, avoidAmbiguous: false,
  numWords: 5, wordSeparator: "-", capitalize: true, includeNumber: true,
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
  toast: "",
};
let totpTimer: ReturnType<typeof setInterval> | undefined;

export function resetVault(): void {
  clearInterval(totpTimer);
  Object.assign(st, {
    list: undefined, page: undefined, loading: false, syncing: false, busy: false, error: undefined, route: { kind: "list" }, query: "",
    folder: "", item: undefined, reveal: new Set(), totp: undefined, confirmDelete: false, draft: undefined,
    gen: { ...GEN_DEFAULTS }, generated: "", toast: "",
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

function tile(name: string, type: number): HTMLElement {
  const letter = name.trim().slice(0, 1).toUpperCase();
  const fallback: IconName = type === 2 ? "note" : type === 4 ? "user" : "key";
  return h("span", { class: "tile", style: `--h:${hue(name)}`, "aria-hidden": "true" }, letter || icon(fallback));
}

function toast(ctx: Ctx, text: string) {
  st.toast = text;
  ctx.rerender();
  setTimeout(() => {
    if (st.toast === text) {
      st.toast = "";
      ctx.rerender();
    }
  }, 1800);
}

async function copy(ctx: Ctx, value: string) {
  await navigator.clipboard.writeText(value);
  void send({ type: "clipboardCopied" }); // schedules clearing
  toast(ctx, t("copied"));
}

function iconButton(ic: IconName, label: string, onclick: () => void, extra: Record<string, unknown> = {}) {
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

function matches(i: VaultItem, q: string): boolean {
  if (st.folder === "none" ? i.folderId : st.folder && i.folderId !== st.folder) return false;
  if (!q) return true;
  return [i.name, i.sub, ...i.uris].some((s) => s.toLowerCase().includes(q));
}

function listView(ctx: Ctx): HTMLElement {
  const listBox = h("div", { class: "group", role: "list" });
  const fill = () => {
    const q = st.query.trim().toLowerCase();
    const items = (st.list?.items ?? []).filter((i) => matches(i, q));
    listBox.replaceChildren(
      ...items.map((i) =>
        h(
          "button",
          { type: "button", class: "row", role: "listitem", onclick: () => open(ctx, { kind: "item", id: i.id }) },
          tile(i.name, i.type),
          h("div", { class: "body" }, h("span", { class: "title" }, i.failed ? t("decryptFailed") : i.name || t("untitled")), i.sub ? h("span", { class: "sub" }, i.sub) : null),
          i.favorite ? icon("star", t("favorite")) : null,
        ),
      ),
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
  const chip = (id: string, label: string) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(st.folder === id), onclick: () => ((st.folder = id), ctx.rerender()) }, label);
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
    folders.length
      ? h("div", { class: "chips scroll", role: "group", "aria-label": t("folders") }, chip("", t("allItems")), ...folders.map((f) => chip(f.id, f.name)), chip("none", t("noFolder")))
      : null,
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
    if (item.ok) return startEdit(ctx, item.data, { password: login.password });
  }
  const url = new URL(login.url);
  startEdit(ctx, undefined, { name: url.hostname, username: login.username, password: login.password, uris: url.origin });
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
              tile(i.name, i.type),
              h("div", { class: "body" }, h("span", { class: "title" }, i.name), i.sub ? h("span", { class: "sub" }, i.sub) : null),
              h("button", { type: "button", class: "btn tonal small", "aria-label": `${t("fill")} ${i.name}`, onclick: () => void fill(ctx, i.id) }, t("fill")),
            ),
          ),
        )
      : null,
    h("button", { type: "button", class: "btn text", onclick: () => void saveFromPage(ctx) }, icon("plus"), t("saveFromPage")),
  );
}

// ---------- item view ----------

function fieldRow(ctx: Ctx, key: string, ic: IconName, label: string, value: string, secret = false): HTMLElement {
  const shown = !secret || st.reveal.has(key);
  return h(
    "div",
    { class: "row field-row" },
    icon(ic),
    h("div", { class: "body" }, h("span", { class: "label" }, label), h("span", { class: `value${secret ? " mono" : ""}` }, shown ? value : "•".repeat(Math.min(value.length, 12)))),
    secret
      ? iconButton(shown ? "eyeOff" : "eye", t(shown ? "hidePassword" : "showPassword"), () => {
          if (shown) st.reveal.delete(key);
          else st.reveal.add(key);
          ctx.rerender();
        })
      : null,
    iconButton("copy", t("copyField", label), () => void copy(ctx, value)),
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
  const summary = st.list?.items.find((i) => i.id === id);
  const type = Number(item.type);
  const editable = !summary?.readOnly && (type === 1 || type === 2);
  const login = obj(item.login);
  const rows: Child[] = [];
  if (login) {
    if (str(login.username)) rows.push(fieldRow(ctx, "username", "user", t("username"), str(login.username)));
    if (str(login.password)) rows.push(fieldRow(ctx, "password", "key", t("password"), str(login.password), true));
    if (str(login.totp)) rows.push(totpRow(ctx, id));
  }
  for (const k of TYPE_OBJECTS) {
    const o = obj(item[k]);
    if (!o) continue;
    for (const [fk, fv] of Object.entries(o)) {
      if (typeof fv === "string" && fv && fk !== "type") rows.push(fieldRow(ctx, `${k}.${fk}`, "note", humanize(fk), fv, SECRET_KEYS.test(fk)));
    }
  }
  const uris = (Array.isArray(login?.uris) ? (login!.uris as Json[]) : []).map((u) => str(u.uri)).filter(Boolean);
  const fields = Array.isArray(item.fields) ? (item.fields as Json[]) : [];
  const folder = st.list?.folders.find((f) => f.id === item.folderId);
  const attachments = Array.isArray(item.attachments) ? item.attachments.length : 0;

  const del = editable
    ? h(
        "button",
        {
          type: "button",
          class: "row danger",
          disabled: st.busy,
          onclick: async () => {
            if (!st.confirmDelete) {
              st.confirmDelete = true;
              return ctx.rerender();
            }
            st.busy = true;
            const r = await send<VaultList>({ type: "deleteItem", id });
            st.busy = false;
            if (r.ok) {
              st.list = r.data;
              open(ctx, { kind: "list" });
              toast(ctx, t("movedToTrash"));
            } else ((st.error = r.error), ctx.rerender());
          },
        },
        icon("trash"),
        h("div", { class: "body" }, h("span", { class: "title" }, t(st.confirmDelete ? "confirmTrash" : "moveToTrash"))),
      )
    : null;

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "top" },
      iconButton("back", t("back"), () => open(ctx, { kind: "list" })),
      h("h1", { class: "ellipsis" }, str(item.name) || t("untitled")),
      item.favorite === true ? icon("star", t("favorite")) : null,
      editable ? iconButton("edit", t("edit"), () => startEdit(ctx, item)) : null,
    ),
    errorBox(),
    summary?.readOnly ? h("p", { class: "note" }, t("readOnlyItem")) : null,
    rows.length ? h("div", { class: "group" }, ...rows) : null,
    ...section(t("websites"), ...uris.map((u) => h("a", { class: "row", href: /^https?:\/\//i.test(u) ? u : `https://${u}`, target: "_blank", rel: "noopener noreferrer" }, icon("globe"), h("div", { class: "body" }, h("span", { class: "title ellipsis" }, u))))),
    ...section(
      t("customFields"),
      ...fields.map((f, i) =>
        Number(f.type) === 3 ? null : fieldRow(ctx, `field.${i}`, "note", str(f.name) || t("untitled"), str(f.value), Number(f.type) === 1),
      ),
    ),
    ...(str(item.notes) ? [h("h2", { class: "section-title" }, t("notes")), h("div", { class: "notes" }, str(item.notes))] : []),
    ...section(
      t("details"),
      folder ? h("div", { class: "row" }, icon("folder"), h("div", { class: "body" }, h("span", { class: "label" }, t("folder")), h("span", { class: "value" }, folder.name))) : null,
      attachments ? h("div", { class: "row" }, icon("attach"), h("div", { class: "body" }, h("span", { class: "value" }, t("attachmentsCount", String(attachments))))) : null,
    ),
    del ? h("div", { class: "group" }, del) : null,
  );
}

// ---------- editor (personal Login / Secure note) ----------

function startEdit(ctx: Ctx, item: Json | undefined, prefill: Partial<Omit<EditDraft, "base">> = {}) {
  const base: Json = item ? structuredClone(item) : { type: 1, favorite: false, reprompt: 0, folderId: null, organizationId: null };
  const login = obj(base.login);
  st.draft = {
    base,
    type: Number(base.type) === 2 ? 2 : 1,
    name: str(base.name),
    username: str(login?.username),
    password: str(login?.password),
    totp: str(login?.totp),
    uris: (Array.isArray(login?.uris) ? (login!.uris as Json[]) : []).map((u) => str(u.uri)).filter(Boolean).join("\n"),
    notes: str(base.notes),
    folderId: str(base.folderId),
    favorite: base.favorite === true,
    ...prefill,
  };
  open(ctx, { kind: "edit", isNew: !item });
}

function buildItem(d: EditDraft): Json {
  const orNull = (s: string) => (s.trim() ? s : null);
  const item: Json = { ...d.base, type: d.type, name: d.name.trim(), notes: orNull(d.notes), folderId: d.folderId || null, favorite: d.favorite };
  if (d.type === 1) {
    const old = obj(d.base.login) ?? {};
    const oldUris = Array.isArray(old.uris) ? (old.uris as Json[]) : [];
    const uris = d.uris.split("\n").map((u) => u.trim()).filter(Boolean).map((u) => oldUris.find((o) => o.uri === u) ?? { uri: u, match: null });
    item.login = { ...old, username: orNull(d.username), password: orNull(d.password), totp: orNull(d.totp), uris };
    delete item.secureNote;
  } else {
    item.secureNote = obj(d.base.secureNote) ?? { type: 0 };
    delete item.login;
  }
  return item;
}

function editView(ctx: Ctx, isNew: boolean): HTMLElement {
  const d = st.draft!;
  const input = (key: "name" | "username" | "password" | "totp", props: Record<string, unknown>) =>
    h("input", { ...props, value: d[key], oninput: (e: Event) => (d[key] = (e.target as HTMLInputElement).value) });
  const area = (key: "uris" | "notes", rows: number) =>
    h("textarea", { id: `edit-${key}`, rows, value: d[key], oninput: (e: Event) => (d[key] = (e.target as HTMLTextAreaElement).value) });
  const field = (id: string, ic: IconName, label: string, control: HTMLElement, trailing?: Child) => {
    control.id = id;
    return h("div", { class: "field" }, icon(ic), h("label", { for: id }, h("span", {}, label), control), trailing);
  };
  const reveal = st.reveal.has("edit-password");
  const typeChip = (type: 1 | 2, label: string, ic: IconName) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(d.type === type), onclick: () => ((d.type = type), ctx.rerender()) }, icon(ic), label);
  const onsubmit = async (e: Event) => {
    e.preventDefault();
    if (!d.name.trim()) {
      st.error = t("nameRequired");
      return ctx.rerender();
    }
    st.busy = true;
    st.error = undefined;
    ctx.rerender();
    const r = await send<VaultList>({ type: "saveItem", item: buildItem(d) });
    st.busy = false;
    if (!r.ok) {
      st.error = r.error;
      return ctx.rerender();
    }
    st.list = r.data;
    st.item = undefined;
    open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) });
    toast(ctx, t("saved"));
  };
  const folderSelect = h(
    "select",
    { onchange: (e: Event) => (d.folderId = (e.target as HTMLSelectElement).value) },
    h("option", { value: "", selected: !d.folderId }, t("noFolder")),
    ...(st.list?.folders ?? []).map((f) => h("option", { value: f.id, selected: f.id === d.folderId }, f.name)),
  );
  const fav = h("input", { type: "checkbox", checked: d.favorite, "aria-label": t("favorite"), onchange: (e: Event) => (d.favorite = (e.target as HTMLInputElement).checked) });
  return h(
    "form",
    { class: "page", onsubmit },
    h(
      "div",
      { class: "top" },
      iconButton("back", t("cancel"), () => open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) })),
      h("h1", {}, t(isNew ? "newItem" : "editItem")),
    ),
    isNew ? h("div", { class: "chips", role: "group", "aria-label": t("itemType") }, typeChip(1, t("typeLogin"), "key"), typeChip(2, t("typeNote"), "note")) : null,
    field("edit-name", "edit", t("name"), input("name", { required: true, "data-autofocus": "1" })),
    d.type === 1 ? field("edit-username", "user", t("username"), input("username", { autocomplete: "off", spellcheck: false })) : null,
    d.type === 1
      ? field(
          "edit-password",
          "key",
          t("password"),
          input("password", { type: reveal ? "text" : "password", autocomplete: "new-password", spellcheck: false, class: "mono" }),
          h(
            "span",
            { class: "trailing" },
            iconButton(reveal ? "eyeOff" : "eye", t(reveal ? "hidePassword" : "showPassword"), () => {
              if (reveal) st.reveal.delete("edit-password");
              else st.reveal.add("edit-password");
              ctx.rerender();
            }),
            iconButton("dice", t("generatePassword"), async () => {
              const r = await send<string>({ type: "generate", options: st.gen });
              if (r.ok) {
                d.password = r.data;
                st.reveal.add("edit-password");
                ctx.rerender();
              }
            }),
          ),
        )
      : null,
    d.type === 1 ? field("edit-totp", "timer", t("totpSecret"), input("totp", { autocomplete: "off", spellcheck: false })) : null,
    d.type === 1 ? field("edit-uris", "globe", t("websitesOnePerLine"), area("uris", 2)) : null,
    field("edit-notes", "note", t("notes"), area("notes", 3)),
    field("edit-folder", "folder", t("folder"), folderSelect),
    h("label", { class: "check" }, h("div", { class: "body" }, t("favorite")), h("span", { class: "switch" }, fav, h("span"))),
    errorBox(),
    st.busy ? h("div", { class: "progress" }) : null,
    h("button", { type: "submit", class: "btn filled wide", disabled: st.busy }, t("save")),
  );
}

export function vaultScreen(ctx: Ctx): HTMLElement {
  if (!st.list && !st.loading && !st.error) void loadList(ctx);
  const r = st.route;
  if (r.kind === "item") return itemView(ctx, r.id);
  if (r.kind === "edit" && st.draft) return editView(ctx, r.isNew);
  return listView(ctx);
}

// ---------- generator ----------

async function regenerate(ctx: Ctx) {
  const r = await send<string>({ type: "generate", options: st.gen });
  if (r.ok) st.generated = r.data;
  else st.error = r.error;
  ctx.rerender();
}

export function generatorScreen(ctx: Ctx): HTMLElement {
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
  const isPass = g.type === "password";
  const chip = (type: string, label: string) => h("button", { type: "button", class: "chip", "aria-pressed": String(g.type === type), onclick: () => set("type", type) }, label);
  return h(
    "div",
    { class: "page" },
    h("div", { class: "top" }, h("h1", {}, t("generator"))),
    h(
      "div",
      { class: "generated" },
      h("output", { class: "mono", "aria-live": "polite", "aria-label": t("generatedValue") }, st.generated || "…"),
      h("div", { class: "trailing" }, iconButton("refresh", t("regenerate"), () => void regenerate(ctx)), iconButton("copy", t("copyField", t("generatedValue")), () => void copy(ctx, st.generated))),
    ),
    h("div", { class: "chips" }, chip("password", t("typePassword")), chip("passphrase", t("typePassphrase"))),
    isPass
      ? h("div", { class: "group" }, range("length", t("length"), 5, 128), toggle("uppercase", "A–Z"), toggle("lowercase", "a–z"), toggle("numbers", "0–9"), toggle("special", "!@#$%^&*"), toggle("avoidAmbiguous", t("avoidAmbiguous")))
      : h(
          "div",
          { class: "group" },
          range("numWords", t("words"), 3, 20),
          h(
            "label",
            { class: "row" },
            h("div", { class: "body" }, h("span", { class: "title" }, t("separator"))),
            h("input", { class: "small-input", value: str(g.wordSeparator), maxLength: 3, onchange: (e: Event) => set("wordSeparator", (e.target as HTMLInputElement).value) }),
          ),
          toggle("capitalize", t("capitalize")),
          toggle("includeNumber", t("includeNumber")),
        ),
    errorBox(),
  );
}
