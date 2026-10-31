// Walking a frame across open shadow roots, and the numeric ids that stand for its elements outside it.

import { MAX_BLOCK_PATH } from "../../shared/page-limits.ts";

export type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const isField = (el: Element): el is Field => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;

/** Elements matching `sel` under `root`, open shadow roots included, in document order. */
export function deepAll(root: ParentNode, sel: string, out: Element[] = []): Element[] {
  // A named input ("querySelector") clobbers a form's own methods: call the native ones.
  for (const el of root instanceof Element ? Element.prototype.querySelectorAll.call(root, "*") : root.querySelectorAll("*")) {
    if (Element.prototype.matches.call(el, sel)) out.push(el);
    if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
  }
  return out;
}

/** Every field of the frame, in document order: a shadow root's fields sit at its host's place. */
export const deepFields = (root: ParentNode = document): Field[] => deepAll(root, "input,select,textarea").filter(isField);

// Not `root.host`: on a document that is whatever element the page named "host".
export const hostOf = (el: Element): Element | null => {
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
};

/** The parent, stepping out of a shadow root at its host. */
export const up = (el: Element): Element | null => el.parentElement ?? hostOf(el);

let next = 1;
const ids = new WeakMap<Element, number>();

/** A number that stands for `el` in this frame until it is gone; the same one for each collection. */
export function idOf(el: Element): number {
  let id = ids.get(el);
  if (id === undefined) ids.set(el, (id = next++));
  return id;
}

/** Ids of `el`'s ancestors below <body>, nearest first: fields that share one are in one block of the page. */
export function blockPath(el: Element): number[] {
  const path: number[] = [];
  for (let p = up(el); p && p !== document.body && p !== document.documentElement && path.length < MAX_BLOCK_PATH; p = up(p)) path.push(idOf(p));
  return path;
}
