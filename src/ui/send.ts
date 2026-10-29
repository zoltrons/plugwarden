// Send screen: the user's sends, create a text or file send, copy its link, delete it.
// Talks to the service worker only; the link (with its key fragment) is built there.
import type { SendItem } from "../shared/messages.ts";
import { type Child, h, send, t } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { copy, type Ctx, iconButton, tile, toast } from "./vault.ts";

const DELETION_DAYS = [1, 2, 3, 7, 14, 30] as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // keep in sync with MAX_SEND_FILE_BYTES in background/vault.ts

interface Draft {
  kind: "text" | "file";
  name: string;
  text: string;
  hidden: boolean;
  file?: File;
  password: string;
  days: number;
  maxAccess: string;
}

const newDraft = (): Draft => ({ kind: "text", name: "", text: "", hidden: false, password: "", days: 7, maxAccess: "" });

const sd = {
  list: undefined as SendItem[] | undefined,
  loading: false,
  busy: false,
  error: undefined as string | undefined,
  draft: undefined as Draft | undefined,
  confirmDelete: "",
};

export function resetSend(): void {
  Object.assign(sd, { list: undefined, loading: false, busy: false, error: undefined, draft: undefined, confirmDelete: "" });
}

async function load(ctx: Ctx) {
  sd.loading = true;
  const r = await send<SendItem[]>({ type: "sendList" });
  sd.loading = false;
  if (r.ok) sd.list = r.data;
  else sd.error = r.error;
  ctx.rerender();
}

function errorBox(): Child {
  return sd.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, sd.error)) : null;
}

async function remove(ctx: Ctx, id: string) {
  if (sd.confirmDelete !== id) {
    sd.confirmDelete = id;
    return ctx.rerender();
  }
  sd.confirmDelete = "";
  const r = await send<SendItem[]>({ type: "deleteSend", id });
  if (r.ok) {
    sd.list = r.data;
    toast(ctx, t("sendDeleted"));
  } else sd.error = r.error;
  ctx.rerender();
}

function listView(ctx: Ctx): HTMLElement {
  const items = sd.list ?? [];
  const date = (iso: string) => (iso ? new Date(iso).toLocaleDateString() : "");
  return h(
    "div",
    { class: "page" },
    h("div", { class: "top" }, h("h1", { style: "flex:1" }, t("send"))),
    errorBox(),
    sd.loading && !sd.list
      ? h("div", { class: "progress" })
      : items.length
        ? h(
            "div",
            { class: "group", role: "list" },
            ...items.map((s) =>
              h(
                "div",
                { class: "row", role: "listitem" },
                tile(s.name, s.type === 1 ? 2 : 1),
                h(
                  "div",
                  { class: "body" },
                  h("span", { class: "title" }, s.failed ? t("decryptFailed") : s.name),
                  h("span", { class: "sub" }, [t("sendDeletes", date(s.deletionDate)), s.hasPassword ? t("password") : "", s.disabled ? t("sendDisabled") : ""].filter(Boolean).join(" · ")),
                ),
                s.failed ? null : iconButton("copy", `${t("copyLink")} ${s.name}`, () => void copy(ctx, s.link)),
                iconButton("trash", sd.confirmDelete === s.id ? t("tapAgainToDelete") : `${t("delete")} ${s.name}`, () => void remove(ctx, s.id), sd.confirmDelete === s.id ? { class: "icon-btn danger" } : {}),
              ),
            ),
          )
        : h("div", { class: "empty" }, icon("send"), h("strong", {}, t("noSends"))),
    h("button", { type: "button", class: "fab", onclick: () => ((sd.draft = newDraft()), (sd.error = undefined), ctx.rerender()) }, icon("plus"), t("newSend")),
  );
}

async function create(ctx: Ctx, d: Draft) {
  if (!d.name.trim()) return ((sd.error = t("nameRequired")), ctx.rerender());
  if (d.kind === "file" && !d.file) return ((sd.error = t("chooseFile")), ctx.rerender());
  if (d.file && d.kind === "file" && d.file.size > MAX_FILE_BYTES) return ((sd.error = t("fileTooLarge")), ctx.rerender());
  sd.busy = true;
  sd.error = undefined;
  ctx.rerender();
  const body = {
    name: d.name.trim(),
    ...(d.kind === "text" ? { text: { text: d.text, hidden: d.hidden } } : {}),
    ...(d.password ? { password: d.password } : {}),
    deletionDate: new Date(Date.now() + d.days * 86_400_000).toISOString(),
    maxAccessCount: d.maxAccess ? Number(d.maxAccess) : null,
    disabled: false,
    hideEmail: false,
  };
  const file = d.kind === "file" && d.file ? { name: d.file.name, data: new Uint8Array(await d.file.arrayBuffer()).toBase64() } : undefined;
  const before = new Set((sd.list ?? []).map((s) => s.id));
  const r = await send<SendItem[]>({ type: "saveSend", send: body, ...(file ? { file } : {}) });
  sd.busy = false;
  if (!r.ok) return ((sd.error = r.error), ctx.rerender());
  sd.list = r.data;
  sd.draft = undefined;
  const created = r.data.find((s) => !before.has(s.id));
  if (created) await copy(ctx, created.link).catch(() => toast(ctx, t("saved")));
  ctx.rerender();
}

function createView(ctx: Ctx, d: Draft): HTMLElement {
  const field = (id: string, ic: IconName, label: string, control: HTMLElement) => {
    control.id = id;
    return h("div", { class: "field" }, icon(ic), h("label", { for: id }, h("span", {}, label), control));
  };
  const input = (key: "name" | "password" | "maxAccess", props: Record<string, unknown>) =>
    h("input", { ...props, value: d[key], oninput: (e: Event) => (d[key] = (e.target as HTMLInputElement).value) });
  const kindChip = (kind: Draft["kind"], label: string, ic: IconName) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(d.kind === kind), onclick: () => ((d.kind = kind), ctx.rerender()) }, icon(ic), label);
  const hidden = h("input", { type: "checkbox", checked: d.hidden, "aria-label": t("hideText"), onchange: (e: Event) => (d.hidden = (e.target as HTMLInputElement).checked) });
  return h(
    "form",
    { class: "page", onsubmit: (e: Event) => (e.preventDefault(), void create(ctx, d)) },
    h("div", { class: "top" }, iconButton("back", t("cancel"), () => ((sd.draft = undefined), (sd.error = undefined), ctx.rerender())), h("h1", {}, t("newSend"))),
    h("div", { class: "chips", role: "group", "aria-label": t("sendType") }, kindChip("text", t("sendText"), "note"), kindChip("file", t("sendFile"), "attach")),
    field("send-name", "edit", t("name"), input("name", { required: true, "data-autofocus": "1" })),
    d.kind === "text"
      ? field("send-text", "note", t("sendText"), h("textarea", { rows: 4, value: d.text, oninput: (e: Event) => (d.text = (e.target as HTMLTextAreaElement).value) }))
      : field("send-file", "attach", t("sendFile"), h("input", { type: "file", onchange: (e: Event) => (d.file = (e.target as HTMLInputElement).files?.[0]) })),
    d.kind === "text" ? h("label", { class: "row" }, icon("eyeOff"), h("div", { class: "body" }, t("hideText")), h("span", { class: "switch" }, hidden, h("span"))) : null,
    field(
      "send-days",
      "timer",
      t("deleteAfter"),
      h("select", { onchange: (e: Event) => (d.days = Number((e.target as HTMLSelectElement).value)) }, ...DELETION_DAYS.map((n) => h("option", { value: String(n), selected: n === d.days }, t("days", String(n))))),
    ),
    field("send-password", "key", t("sendPasswordOptional"), input("password", { type: "password", autocomplete: "new-password" })),
    field("send-max", "user", t("maxAccessOptional"), input("maxAccess", { type: "number", min: 1, inputMode: "numeric" })),
    errorBox(),
    sd.busy ? h("div", { class: "progress" }) : null,
    h("button", { type: "submit", class: "btn filled wide", disabled: sd.busy }, t("createSendCopyLink")),
  );
}

export function sendScreen(ctx: Ctx): HTMLElement {
  if (!sd.list && !sd.loading && !sd.error) void load(ctx);
  return sd.draft ? createView(ctx, sd.draft) : listView(ctx);
}
