// "Pick from page": the user points at a field instead of finding out what it is called in the page's HTML.
// Also what the context menu's "Copy custom field name" reads.
import type { PageApi } from "./page.ts";

export interface PickedField {
  name: string;
  fieldType: string;
}

const NOT_PICKABLE = ["hidden", "button", "submit", "reset", "image", "file"];
const HIGHLIGHT = "all:initial!important;position:fixed!important;z-index:2147483647!important;pointer-events:none!important;display:none;box-sizing:border-box;border:2px solid #175ddc;background:rgba(23,93,220,.15);border-radius:4px";
const BANNER =
  "all:initial!important;position:fixed!important;top:12px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;pointer-events:none!important;display:block;font:14px system-ui,sans-serif;color:#fff;background:#175ddc;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3)";

type Pickable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const pickable = (el: unknown): el is Pickable =>
  (el instanceof HTMLInputElement && !NOT_PICKABLE.includes(el.type) && !el.readOnly && !el.disabled) || ((el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && !el.disabled && !(el instanceof HTMLTextAreaElement && el.readOnly));

/** Generated per page load (`:r3:`, `input-1234`, `a1b2c3d4`): a custom field named after one fails next time. */
const looksGenerated = (id: string) => /^:|\d{3,}|[0-9a-f]{8,}/i.test(id);

/** The best name for a custom field that fills `el`: an attribute unique on the page, else what its label says. */
export function fieldName(el: Pickable, pw: PageApi): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const names = ["id", "name", "aria-label", "placeholder"].flatMap((a) => {
    const v = el.getAttribute(a);
    return v ? [{ v, a, unique: root.querySelectorAll(`[${a}="${CSS.escape(v)}"]`).length === 1 }] : [];
  });
  const stable = names.find((n) => n.unique && !(n.a === "id" && looksGenerated(n.v)));
  if (stable) return stable.v;
  const f = pw.collectActive(el).fields.find((d) => d.isActive);
  return (f?.label || f?.labelBefore || f?.labelAfter || names[0]?.v || "").trim();
}

/** The field a clicked element stands for: a label and what is inside one point at their control. */
export function fieldOf(clicked: Element | undefined): Pickable | undefined {
  const label = clicked?.closest("label");
  const el = clicked instanceof HTMLLabelElement || (clicked instanceof HTMLSpanElement && label) ? label?.control : clicked;
  return pickable(el) ? el : undefined;
}

let stopCurrent: (() => void) | undefined;

export const picking = () => !!stopCurrent;

export const stopPicker = () => stopCurrent?.();

/** Lets the user pick a field of this frame. `done` gets it, or nothing on Escape; `stopPicker` is silent. */
export function startPicker(pw: PageApi, done: (field: PickedField | undefined) => void): void {
  stopCurrent?.();
  const host = document.createElement("plugwarden-picker");
  host.style.cssText = "all:initial!important;display:block!important";
  const shadow = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.style.cssText = HIGHLIGHT;
  shadow.append(box);
  if (window === top) {
    const banner = document.createElement("div");
    banner.setAttribute("role", "status");
    banner.style.cssText = BANNER;
    banner.textContent = chrome.i18n.getMessage("pickFieldBanner");
    shadow.append(banner);
  }
  document.documentElement.append(host);

  const show = (el: Pickable | undefined) => {
    box.style.display = el ? "block" : "none";
    if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const target = (e: Event) => fieldOf(e.composedPath()[0] as Element);
  const pick = (el: Pickable) => {
    const name = fieldName(el, pw);
    // Nothing to call it by: stay in the picker, the user can point at another one.
    if (!name) return;
    stop();
    done({ name, fieldType: el.type });
  };
  const swallow = (e: Event) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onClick = (e: Event) => {
    if (!e.isTrusted) return;
    swallow(e);
    const el = target(e);
    if (el) pick(el);
  };
  const onMove = (e: Event) => show(target(e));
  const onKey = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    if (e.key === "Escape") {
      swallow(e);
      stop();
      done(undefined);
    } else if (e.key === "Enter" && target(e)) {
      swallow(e);
      pick(target(e)!);
    }
  };
  const blocked = ["mousedown", "mouseup", "pointerdown", "pointerup", "submit"];
  const stop = () => {
    stopCurrent = undefined;
    host.remove();
    for (const type of blocked) removeEventListener(type, swallow, true);
    removeEventListener("click", onClick, true);
    removeEventListener("mousemove", onMove, true);
    removeEventListener("focusin", onMove, true);
    removeEventListener("keydown", onKey, true);
    clearTimeout(timer);
  };
  // A forgotten picker must not keep eating the page's clicks.
  const timer = setTimeout(() => {
    stop();
    done(undefined);
  }, 120_000);
  for (const type of blocked) addEventListener(type, swallow, true);
  addEventListener("click", onClick, true);
  addEventListener("mousemove", onMove, true);
  addEventListener("focusin", onMove, true); // Tab and Enter pick too
  addEventListener("keydown", onKey, true);
  stopCurrent = stop;
}
