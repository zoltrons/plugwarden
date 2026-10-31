// Inline menu (menu.html), framed by the content script under a login / card / identity field.
// An extension page, so the website cannot read the list. Fill happens in the service worker.
import type { MenuData } from "../shared/messages.ts";
import { guardClicks, h, send as ask, t } from "./dom.ts";
import { icon } from "./icons.ts";
import { tile } from "./vault.ts";

const app = document.getElementById("app")!;
/** The secret of the document that opened this menu (see content.ts); the worker checks it. */
const nonce = location.hash.slice(1);

function row(icn: Node, title: string, sub: string, onclick: () => void, label = title) {
  return h("button", { type: "button", class: "row", "aria-label": label, onclick }, icn, h("div", { class: "body" }, h("span", { class: "title" }, title), sub ? h("span", { class: "sub" }, sub) : null));
}

async function render() {
  const r = await ask<MenuData>({ type: "inlineList", nonce });
  if (!r.ok) return app.replaceChildren(h("div", { class: "note" }, r.error));
  const d = r.data;
  if (d.locked)
    return app.replaceChildren(h("div", { class: "group" }, row(icon("lock"), t("unlockToFill"), t("appName"), () => void ask({ type: "inlineUnlock", nonce }))));
  // A website waiting on a conditional passkey request: the stored passkey is one click away.
  const passkey = d.passkey
    ? row(
        icon("key"),
        t("passkeySignInTitle"),
        t("appName"),
        async () => {
          const p = await ask({ type: "inlinePasskey", nonce });
          if (!p.ok) app.replaceChildren(h("div", { class: "note" }, p.error));
        },
        t("passkeySignInTitle"),
      )
    : null;
  const create = d.create ? row(icon("plus"), t("createAccount"), t("appName"), () => void ask({ type: "inlineNewLogin", nonce })) : null;
  app.replaceChildren(
    h(
      "div",
      { class: "group", role: "list", "aria-label": t("appName") },
      passkey,
      create,
      ...d.items.map((i) =>
        row(tile(i.name, i.type), i.name || t("untitled"), i.sub, async () => {
          const f = await ask({ type: "inlineFill", id: i.id, nonce });
          if (!f.ok) app.replaceChildren(h("div", { class: "note" }, f.error));
        }, `${t("fill")} ${i.name}`),
      ),
    ),
  );
}

guardClicks();
void render();
