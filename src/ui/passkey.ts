// Approval window for a website's passkey request. The service worker opens popup.html?passkey=<id>;
// after unlocking (if needed) the user picks a passkey, saves a new one, or hands the call back to the browser.
import type { PasskeyPrompt } from "../shared/messages.ts";
import { h, send, t } from "./dom.ts";
import { icon } from "./icons.ts";
import { type Ctx, tile } from "./vault.ts";

export const passkeyRequestId = new URLSearchParams(location.search).get("passkey");

const pk = { prompt: undefined as PasskeyPrompt | undefined, loading: false, busy: false, error: undefined as string | undefined };

async function load(ctx: Ctx) {
  pk.loading = true;
  const r = await send<PasskeyPrompt>({ type: "passkeyPrompt", id: passkeyRequestId! });
  pk.loading = false;
  if (r.ok) pk.prompt = r.data;
  else pk.error = r.error;
  ctx.rerender();
}

async function decide(ctx: Ctx, action: "use" | "fallback", itemId?: string, credentialId?: string) {
  pk.busy = true;
  ctx.rerender();
  const r = await send<null>({ type: "passkeyDecision", id: passkeyRequestId!, action, ...(itemId ? { itemId, credentialId } : {}) });
  if (r.ok) return window.close();
  pk.busy = false;
  pk.error = r.error;
  ctx.rerender();
}

export function passkeyScreen(ctx: Ctx): HTMLElement {
  if (!pk.prompt && !pk.loading && !pk.error) void load(ctx);
  const p = pk.prompt;
  const create = p?.kind === "create";
  return h(
    "div",
    { class: "page" },
    h("div", { class: "brand" }, h("div", { class: "logo" }, icon("key")), h("h1", {}, t(create ? "passkeySaveTitle" : "passkeySignInTitle")), p ? h("p", {}, p.origin) : null),
    pk.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, pk.error)) : null,
    !p
      ? pk.error ? null : h("div", { class: "progress" })
      : create
        ? h(
            "div",
            { class: "actions" },
            h("p", { class: "note" }, t("passkeySaveFor", p.userName ?? "", p.rpName || p.rpId)),
            h("button", { type: "button", class: "btn filled wide", disabled: pk.busy, onclick: () => void decide(ctx, "use") }, t("passkeySave")),
          )
        : p.candidates.length
          ? h(
              "div",
              { class: "group", role: "list" },
              ...p.candidates.map((c) =>
                h(
                  "button",
                  { type: "button", class: "row", role: "listitem", disabled: pk.busy, onclick: () => void decide(ctx, "use", c.itemId, c.credentialId) },
                  tile(c.name, 1),
                  h("div", { class: "body" }, h("span", { class: "title" }, c.name), h("span", { class: "sub" }, c.userName)),
                ),
              ),
            )
          : h("div", { class: "empty" }, icon("key"), h("strong", {}, t("passkeyNone"))),
    pk.busy ? h("div", { class: "progress" }) : null,
    h("button", { type: "button", class: "btn text", disabled: pk.busy, onclick: () => void decide(ctx, "fallback") }, t("passkeyUseBrowser")),
  );
}
