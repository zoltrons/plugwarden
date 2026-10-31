// Writes a fill plan into the page. Everything is checked again here: the page has had time to change
// since it was collected, and only what is still on screen in this origin gets a value.
import { allButtons, isFillable } from "../collector/collect-frame.ts";
import { deepFields, type Field, idOf, up } from "../collector/shadow-dom.ts";
import type { ExecuteFill, FillResult, ValueFormat } from "../types.ts";

/** Writes through the prototype setter, so framework-controlled inputs see the change. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  for (let p: object | null = Object.getPrototypeOf(el); p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, "value");
    if (d?.set) return void d.set.call(el, value);
  }
  el.value = value;
}

/** Marks a filled field, in a colour that shows on its background, until the user edits it. */
export function applyAutofillHighlight(el: Field): void {
  let dark = false;
  for (let p: Element | null = el; p; p = up(p)) {
    const c = getComputedStyle(p).backgroundColor.match(/^rgba?\((.+)\)$/)?.[1];
    if (!c) continue;
    const [r = 0, g = 0, b = 0, a = 1] = c.split(/[\s,/]+/).map(Number);
    // Most inputs and pages are transparent: the colour that shows is an ancestor's.
    if (a === 0) continue;
    dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 <= 0.5;
    break;
  }
  el.setAttribute("data-pw-autofilled", dark ? "dark" : "light");
  el.style.setProperty("outline", `2px solid ${dark ? "#7fb0ff" : "#175ddc"}`, "important");
  el.style.setProperty("outline-offset", "-2px", "important");
  // once: a later fill's own input event drops this listener, and the fill then adds a new one.
  el.addEventListener(
    "input",
    () => {
      el.removeAttribute("data-pw-autofilled");
      el.style.removeProperty("outline");
      el.style.removeProperty("outline-offset");
    },
    { once: true },
  );
}

/** Fills the way typing looks to a page: click, focus, key events, value, input, change. */
export function fillFieldWithEvents(el: Field, value: string): void {
  el.focus();
  if (el instanceof HTMLSelectElement) {
    el.value = value;
  } else {
    el.click();
    const key = { bubbles: true, composed: true, cancelable: true, key: "Unidentified" };
    el.dispatchEvent(new KeyboardEvent("keydown", key));
    el.dispatchEvent(new KeyboardEvent("keypress", key));
    el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    setNativeValue(el, value);
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  if (!(el instanceof HTMLSelectElement)) el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "Unidentified" }));
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  if (el.value) applyAutofillHighlight(el); // a page may have refused the value
  el.blur(); // forms that validate, or update their model, on blur
}

/** Enter in `el`, then the submit a real one would cause: synthetic keys do not submit a form by themselves. */
export function simulateEnterSubmit(el: Field): void {
  el.focus();
  const init: KeyboardEventInit = { code: "Enter", key: "Enter", keyCode: 13, bubbles: true, cancelable: true, composed: true, view: window } as KeyboardEventInit;
  const handled = !el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: 13 } as KeyboardEventInit));
  el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertLineBreak", composed: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  if (!handled && el.form) HTMLFormElement.prototype.requestSubmit.call(el.form);
}

function formatted(value: string, format: ValueFormat | undefined): string {
  switch (format) {
    case "digits":
      return value.replace(/\D/g, "");
    case "expCompact":
      return value.replace("/", "");
    case "expLong":
      return value.replace(/\/(\d\d)$/, "/20$1");
    case "yearShort":
      return value.slice(-2);
    default:
      return value;
  }
}

/** Sites use `01`, `1`, `January`-free numbers and `2030` / `30` for the same option. */
function selectOption(el: HTMLSelectElement, v: string): string | undefined {
  const same = (a: string) => a === v || (/^\d+$/.test(v) && /^\d+$/.test(a) && (Number(a) === Number(v) || (v.length === 4 && a === v.slice(-2))));
  return [...el.options].find((o) => same(o.value) || same(o.text.trim()))?.value;
}

export function executeFill(req: ExecuteFill): FillResult {
  if (location.origin !== req.origin) return { filled: false, reason: "origin" };
  const byId = new Map(deepFields().map((el) => [idOf(el), el]));
  let n = 0;
  for (const op of req.ops) {
    const el = byId.get(op.fieldId);
    if (!el?.isConnected || !isFillable(el) || (req.onlyEmpty && el.value !== "")) continue;
    let value: string | undefined = formatted(op.value, op.format);
    if (el instanceof HTMLSelectElement) value = selectOption(el, value);
    if (value === undefined) continue;
    fillFieldWithEvents(el, value);
    n++;
  }
  if (req.submit && n) {
    const submit = req.submit;
    const button = submit.kind === "click" ? allButtons().find((b) => idOf(b) === submit.fieldId && b.checkVisibility()) : undefined;
    if (button) button.click();
    else {
      const field = byId.get(submit.kind === "click" ? submit.fallbackFieldId : submit.fieldId);
      if (field?.isConnected) simulateEnterSubmit(field);
    }
  }
  return n || !req.onlyEmpty ? { filled: true } : { filled: false, reason: "noFields" };
}
