// Save / update bar (bar.html), framed by the content script at the top of the page after a login
// was submitted. The credentials stay in the service worker; this page only shows host and username.
import type { BarInfo } from "../shared/messages.ts";
import { h, send as ask, t } from "./dom.ts";
import { icon } from "./icons.ts";

const app = document.getElementById("app")!;

async function act(action: "save" | "never" | "close") {
  for (const b of app.querySelectorAll("button")) b.disabled = true;
  const r = await ask({ type: "barAction", action });
  if (!r.ok) app.append(h("p", { class: "note", role: "alert" }, r.error));
}

void ask<BarInfo | null>({ type: "barInfo" }).then((r) => {
  if (!r.ok || !r.data) return;
  const d = r.data;
  app.replaceChildren(
    h(
      "div",
      { class: "bar" },
      h(
        "div",
        { class: "top" },
        h("span", { class: "logo-sm" }, icon("shield")),
        h("div", { class: "body" }, h("strong", {}, t(d.kind === "add" ? "barSaveTitle" : "barUpdateTitle")), h("span", { class: "sub" }, d.username ? `${d.username} · ${d.host}` : d.host)),
        h("button", { type: "button", class: "icon-btn", "aria-label": t("close"), onclick: () => void act("close") }, icon("close")),
      ),
      h(
        "div",
        { class: "actions row-actions" },
        d.kind === "add" ? h("button", { type: "button", class: "btn text", onclick: () => void act("never") }, t("barNever")) : null,
        h("button", { type: "button", class: "btn filled", onclick: () => void act("save") }, t(d.kind === "add" ? "save" : "barUpdate")),
      ),
    ),
  );
});
