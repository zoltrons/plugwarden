// A field's label, from its five possible sources. Most sites do not use <label for>.
import { type Field, hostOf } from "./shadow-dom.ts";

const MAX_LABEL_LENGTH = 150;
const WALK_NODES = 40;
export const FIELDS = "input:not([type=hidden]),select,textarea";

const isControl = (n: Node) => n instanceof HTMLButtonElement || n instanceof HTMLSelectElement || n instanceof HTMLTextAreaElement || (n instanceof HTMLInputElement && n.type !== "hidden");

/** Text a user could read as a label: visible, has words (not a lone "*"). */
function labelText(n: Node): string {
  const text = n.nodeType === Node.TEXT_NODE ? (n.textContent ?? "").trim() : "";
  return text && /\p{L}/u.test(text) && n.parentElement?.checkVisibility() ? text : "";
}

/** The text right before a field, up to the previous control or its form's edge. */
function walkBackward(el: Field): string {
  let budget = WALK_NODES;
  // A component's own shadow root often holds only the input: its label is outside, before the host.
  for (let from: Element | null = el; from; from = hostOf(from)) {
    const form = from.closest("form");
    const walker = document.createTreeWalker(from.getRootNode(), NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    walker.currentNode = from;
    while (budget-- > 0 && walker.previousNode()) {
      const n = walker.currentNode;
      if (isControl(n) || n instanceof HTMLFormElement) return "";
      const text = labelText(n);
      if (!text) continue;
      // In another form, or longer than a label: about something else.
      if (text.length > MAX_LABEL_LENGTH || Element.prototype.closest.call(n.parentElement!, "form") !== form) return "";
      // In a block that holds a control of its own: that control's label, not this field's.
      let top = n.parentElement!;
      if (Node.prototype.contains.call(top, from)) return text;
      while (top.parentElement && !Node.prototype.contains.call(top.parentElement, from)) top = top.parentElement;
      return top.querySelector(FIELDS) ? "" : text;
    }
  }
  return "";
}

/** The text after a field, for inputs that put their label behind them. Only when the field is alone in
 * its parent: anywhere else that text is the next field's label. */
function walkForward(el: Field): string {
  const box = el.parentElement;
  if (!box || box.querySelectorAll(FIELDS).length > 1) return "";
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  walker.currentNode = el;
  for (let i = 0; i < WALK_NODES && walker.nextNode(); i++) {
    const n = walker.currentNode;
    if (isControl(n) || n instanceof HTMLAnchorElement) return ""; // a "Forgot password?" link names nothing
    const text = labelText(n);
    if (text) return text.length <= MAX_LABEL_LENGTH ? text : "";
  }
  return "";
}

export function walkDomForLabel(el: Field, direction: "BACKWARD" | "FORWARD"): string {
  return direction === "BACKWARD" ? walkBackward(el) : walkForward(el);
}

export function extractExplicitLabels(el: Field): string {
  return [...(el.labels ?? [])].map((l) => l.textContent ?? "").join(" ").trim();
}

export function extractAriaLabel(el: Field): string {
  const seen = [el.getAttribute("aria-label") ?? ""];
  const root = el.getRootNode() as Document | ShadowRoot;
  for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/)) if (id) seen.push(root.getElementById(id)?.textContent ?? "");
  return seen.join(" ").trim();
}
