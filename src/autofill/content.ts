// Content script on every http(s) page and frame, right after page.js. It watches for focus and for a
// first password field, and scans nothing else. For login, card and identity fields it shows Plugwarden's
// inline menu, an extension iframe (menu.html) the page cannot read; what a field is, the list and the fill
// come from the service worker. It also reports submitted logins so Plugwarden can offer to save or update
// them (bar.html, top frame only). Bundled as a classic script and kept small.
import { watchForPasswordField } from "./collector/field-watcher.ts";
import type { PageApi } from "./page.ts";
import { fieldName, fieldOf, picking, startPicker, stopPicker } from "./picker.ts";

const pw = (globalThis as unknown as { plugwarden: PageApi }).plugwarden;

const MENU_TYPES = ["text", "email", "tel", "", "search", "number", "password"];

/** Only a field that can type a value is worth asking the service worker about. */
const askable = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && !el.disabled && !el.readOnly && MENU_TYPES.includes(el.type);

/** The focused element, looking inside open shadow roots. */
function active(): Element | null {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

// ---------- inline menu ----------

let host: HTMLElement | undefined;
let frame: HTMLIFrameElement | undefined;
let anchor: HTMLInputElement | undefined;
let dismissed: HTMLInputElement | undefined;
/**
 * Per-document secret handed to the menu frame it opens. The menu is inside a closed shadow root, so
 * the page cannot read this; a menu the page frames itself does not have it and is refused.
 * (crypto.getRandomValues, not randomUUID: content scripts also run on plain-http pages.)
 */
const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
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

async function open(el: HTMLInputElement) {
  if (anchor === el || dismissed === el || Date.now() < quietUntil) return;
  const mine = ++gen;
  const details = pw.collectActive(el);
  const r = ((await chrome.runtime.sendMessage({ type: "inlineFocus", nonce, details }).catch(() => undefined)) as { data?: { rows: number; kind?: string } } | undefined)?.data;
  if (r?.kind === "login") pw.setFocused((focusedLogin = el)); // read by the fill
  if (mine !== gen) return;
  // rows = 0: nothing to offer (no matches, not logged in, not a field we fill), so stay out of the way.
  if (!r?.rows) {
    if (el !== anchor) close();
    return;
  }
  if (active() !== el || Date.now() < quietUntil) return;
  close();
  anchor = el;
  host = document.createElement("plugwarden-menu");
  host.style.cssText = "all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;opacity:1!important;transform:none!important;filter:none!important";
  frame = document.createElement("iframe");
  frame.src = `${chrome.runtime.getURL("menu.html")}#${nonce}`;
  frame.allow = "clipboard-write";
  // Row metrics come from the menu's own CSS: 44 px rows, 1 px separators, 6 px frame padding.
  frame.style.cssText = `all:initial;display:block;width:100%;height:${Math.min(r.rows, 5) * 45 + 13}px;border:0;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.28);color-scheme:normal`;
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
    if (el === host || picking()) return; // focus moved into our menu, or the user is pointing at fields
    if (askable(el)) void open(el);
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
    if (picking()) return;
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
    if (picking()) return;
    const el = e.composedPath()[0] as Element;
    if (el === dismissed) {
      dismissed = undefined;
      if (askable(el)) void open(el);
    }
    // Submit buttons (a <button> without a type is one), and the plain buttons single-page apps use when
    // they say what they do; not "show password" toggles and the like. The click may land on a child.
    const b = el.closest<HTMLButtonElement>("button,input[type=submit],[role=button]");
    if (b && (b.type === "submit" || /log.?in|sign.?(in|up)|regist|create|continue|next|submit|giri[sş]|kay[iı]t|devam/.test((b.textContent || b.value || "").toLowerCase()))) setTimeout(report);
  },
  true,
);

addEventListener("submit", () => report(), true);

// ---------- autofill on page load ----------

/** The service worker decides whether anything is filled (setting, lock, matches). */
const offerPageLoad = () => void chrome.runtime.sendMessage({ type: "pageLoad" }).catch(() => undefined);

// Once per document, when its first password field exists, however late a single-page app renders it.
watchForPasswordField(offerPageLoad);
// bfcache returns, like the official autofiller.
addEventListener("pageshow", (e) => {
  if ((e as PageTransitionEvent).persisted && pw.hasPasswordField()) offerPageLoad();
});

// ---------- save / update detection ----------

const REPORT_GAP_MS = 5000;

let reported = "";
let lastReport = 0;

function report() {
  // A page can fire submit events itself, and whether the bar appears tells it if a guessed password
  // matches the saved one: only a real gesture counts, and only one guess per REPORT_GAP_MS.
  if (!navigator.userActivation.isActive) return;
  const login = pw.readLogin();
  if (!login) return;
  const key = `${login.username}\n${login.password}`;
  if (key === reported || Date.now() - lastReport < REPORT_GAP_MS) return;
  reported = key;
  lastReport = Date.now();
  void chrome.runtime.sendMessage({ type: "loginSubmitted", username: login.username, password: login.password }).catch(() => undefined);
}

// ---------- "Copy custom field name" ----------

/** A menu can only be told about an element while it opens. Only the user's own right click counts. */
let rightClicked: Element | undefined;
addEventListener(
  "contextmenu",
  (e) => {
    if (e.isTrusted) rightClicked = e.composedPath()[0] as Element;
  },
  true,
);

// ---------- messages from the service worker ----------

let bar: HTMLElement | undefined;

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply: (name: string) => void) => {
  if (msg.type === "clickedFieldName") {
    const el = fieldOf(rightClicked);
    return void reply(el ? fieldName(el, pw) : "");
  }
  if (msg.type === "pickerStart") {
    close();
    startPicker(pw, (field) => void chrome.runtime.sendMessage({ type: "fieldPicked", name: field?.name ?? "", fieldType: field?.fieldType ?? "" }).catch(() => undefined));
    return void reply("");
  }
  if (msg.type === "pickerStop") stopPicker();
  if (msg.type === "inlineClose") {
    stopPicker(); // also how a lock reaches every tab
    quietUntil = Date.now() + 1000;
    close();
  }
  // A website waiting on a conditional passkey request appeared (or went away): refresh the menu. The
  // field may not have had a menu yet (no matching logins when it was focused), so fall back to it.
  if (msg.type === "passkeyAvailable") {
    const el = anchor ?? (focusedLogin && active() === focusedLogin ? focusedLogin : undefined);
    if (el) {
      close();
      void open(el);
    }
  }
  if (msg.type === "barShow" && window === top) {
    // Rebuilt on every show so the frame always carries the current save's token.
    bar?.remove();
    bar = document.createElement("plugwarden-bar");
    bar.style.cssText = "all:initial!important;position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;display:block!important;opacity:1!important;transform:none!important;filter:none!important;width:380px!important;max-width:calc(100vw - 24px)!important";
    const f = document.createElement("iframe");
    f.src = `${chrome.runtime.getURL("bar.html")}#${String((msg as { token?: unknown }).token ?? "")}`;
    f.style.cssText = "all:initial;display:block;width:100%;height:132px;border:0;border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.28);color-scheme:normal";
    bar.attachShadow({ mode: "closed" }).append(f);
    document.documentElement.append(bar);
  }
  if (msg.type === "barHide") {
    bar?.remove();
    bar = undefined;
  }
});
