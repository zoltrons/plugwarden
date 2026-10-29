// Content script on every http(s) page and frame. Idle until the user focuses an input: it scans
// nothing on load. For login, card and identity fields it shows Plugwarden's inline menu, an extension
// iframe (menu.html) the page cannot read; the list and the fill come from the service worker. It also
// reports submitted logins so Plugwarden can offer to save or update them (bar.html, top frame only).
// Bundled as a classic script and kept small.
import { readLogin } from "./page.ts";

type Kind = "login" | "card" | "identity";

const IDENTITY = /^(name|given-name|additional-name|family-name|email|tel|organization|street-address|address-line[123]|address-level[12]|postal-code|country|country-name)$/;
const TEXTISH = ["text", "email", "tel", "", "search", "number"];

/** What kind of menu a field gets, if any. The autocomplete attribute wins; names and ids are hints. */
function kindOf(el: Element): Kind | undefined {
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return undefined;
  if (el.type === "password") return "login";
  if (!TEXTISH.includes(el.type)) return undefined;
  const ac = el.autocomplete.toLowerCase().split(/\s+/).pop() ?? "";
  const hint = `${el.name} ${el.id} ${el.getAttribute("aria-label") ?? ""} ${el.placeholder}`.toLowerCase();
  if (ac.startsWith("cc-") || /card.?num|cc.?num|cvc|cvv|csc|card.?holder|expir/.test(hint)) return "card";
  if (ac === "username" || ac === "webauthn") return "login";
  if (IDENTITY.test(ac) && !(ac === "email" && hasPassword(el))) return "identity";
  if (/user|login|e-?mail|account/.test(hint) && hasPassword(el)) return "login";
  return undefined;
}

/** The focused element, looking inside open shadow roots. */
function active(): Element | null {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

const hasPassword = (el: HTMLInputElement) => !!(el.form ?? document).querySelector("input[type=password]");

// ---------- inline menu ----------

let host: HTMLElement | undefined;
let frame: HTMLIFrameElement | undefined;
let anchor: HTMLInputElement | undefined;
let dismissed: HTMLInputElement | undefined;
/** Focus generation: an in-flight open() must not reopen the menu after a newer focus or close. */
let gen = 0;
/** Last login field focused, also when the menu had nothing to offer: a later passkey request reopens it. */
let focusedLogin: HTMLInputElement | undefined;
/** The fill itself focuses fields: do not reopen the menu right away. */
let quietUntil = 0;

function place() {
  if (!host || !anchor) return;
  const r = anchor.getBoundingClientRect();
  if (!r.width || r.bottom < 0 || r.top > innerHeight) return close();
  Object.assign(host.style, { top: `${r.bottom + 4}px`, left: `${Math.max(4, Math.min(r.left, innerWidth - 324))}px`, width: `${Math.max(r.width, 300)}px` });
}

function close() {
  gen++;
  host?.remove();
  host = frame = anchor = undefined;
  removeEventListener("scroll", place, true);
  removeEventListener("resize", place);
}

async function open(el: HTMLInputElement, kind: Kind) {
  if (kind === "login") focusedLogin = el;
  if (anchor === el || dismissed === el || Date.now() < quietUntil) return;
  const mine = ++gen;
  const r = ((await chrome.runtime.sendMessage({ type: "inlineFocus", kind }).catch(() => undefined)) as { data?: { rows: number } } | undefined)?.data;
  // rows = 0: nothing to offer (no matches, or not logged in), so stay out of the way.
  if (mine !== gen || !r?.rows || active() !== el || Date.now() < quietUntil) return;
  close();
  anchor = el;
  host = document.createElement("plugwarden-menu");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:block";
  frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("menu.html");
  frame.allow = "clipboard-write";
  frame.style.cssText = `all:initial;display:block;width:100%;height:${Math.min(r.rows, 5) * 56 + 16}px;border:0;border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.28);color-scheme:normal`;
  host.attachShadow({ mode: "closed" }).append(frame);
  document.documentElement.append(host);
  place();
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
}

addEventListener(
  "focusin",
  (e) => {
    const el = e.composedPath()[0] as Element; // fields inside open shadow roots too
    if (el === host) return; // focus moved into our menu
    const kind = kindOf(el);
    if (kind) void open(el as HTMLInputElement, kind);
    else if (el !== anchor) close();
  },
  true,
);

addEventListener(
  "focusout",
  () =>
    setTimeout(() => {
      if (document.activeElement !== host && active() !== anchor) close();
    }),
  true,
);

addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && host) {
      dismissed = anchor;
      close();
    }
    if (e.key === "Enter" && (e.composedPath()[0] as HTMLInputElement).type === "password") report();
  },
  true,
);

// A click reopens a menu that was dismissed with Escape.
addEventListener(
  "click",
  (e) => {
    const el = e.composedPath()[0] as Element;
    if (el === dismissed) {
      dismissed = undefined;
      const kind = kindOf(el);
      if (kind) void open(el as HTMLInputElement, kind);
    }
    // Submit buttons only (a <button> without a type is one), not "show password" toggles and the like.
    if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.type === "submit") setTimeout(report);
  },
  true,
);

addEventListener("submit", () => report(), true);

// ---------- save / update detection ----------

let reported = "";

function report() {
  const login = readLogin();
  if (!login) return;
  const key = `${login.username}\n${login.password}`;
  if (key === reported) return;
  reported = key;
  void chrome.runtime.sendMessage({ type: "loginSubmitted", username: login.username, password: login.password }).catch(() => undefined);
}

// ---------- messages from the service worker ----------

let bar: HTMLElement | undefined;

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg.type === "inlineClose") {
    quietUntil = Date.now() + 1000;
    close();
  }
  // A website waiting on a conditional passkey request appeared (or went away): refresh the menu. The
  // field may not have had a menu yet (no matching logins when it was focused), so fall back to it.
  if (msg.type === "passkeyAvailable") {
    const el = anchor ?? (focusedLogin && active() === focusedLogin ? focusedLogin : undefined);
    const kind = el && kindOf(el);
    if (el && kind) {
      close();
      void open(el, kind);
    }
  }
  if (msg.type === "barShow" && window === top && !bar) {
    bar = document.createElement("plugwarden-bar");
    bar.style.cssText = "all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;display:block;width:380px;max-width:calc(100vw - 24px)";
    const f = document.createElement("iframe");
    f.src = chrome.runtime.getURL("bar.html");
    f.style.cssText = "all:initial;display:block;width:100%;height:132px;border:0;border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.28);color-scheme:normal";
    bar.attachShadow({ mode: "closed" }).append(f);
    document.documentElement.append(bar);
  }
  if (msg.type === "barHide") {
    bar?.remove();
    bar = undefined;
  }
});
