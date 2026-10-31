// Watches a frame for its first password field, which single-page apps render long after load.
import { deepAll } from "./shadow-dom.ts";

const SETTLE_MS = 300;
const MAX_PENDING = 200;
const PASSWORD = "input[type=password]";

/** Calls `found` once, when a password field exists; then stops looking. */
export function watchForPasswordField(found: () => void): void {
  let pending: Element[] = [];
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hit = () => {
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    found();
  };
  // Mutations do not cross into shadow roots, so each one found is observed on its own.
  const watchRoots = (root: ParentNode) => {
    for (const el of deepAll(root, "*")) if (el.shadowRoot) observer.observe(el.shadowRoot, { childList: true, subtree: true });
  };
  const settle = () => {
    timer = undefined;
    const roots = overflow ? [document] : pending;
    pending = [];
    overflow = false;
    if (roots.some((r) => (r instanceof Element && r.matches(PASSWORD)) || deepAll(r, PASSWORD).length)) return hit();
    roots.forEach(watchRoots);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) pending.length < MAX_PENDING ? pending.push(n) : (overflow = true);
    if ((pending.length || overflow) && timer === undefined) timer = setTimeout(settle, SETTLE_MS);
  });
  const start = () => {
    if (deepAll(document, PASSWORD).length) return found();
    observer.observe(document, { childList: true, subtree: true });
    watchRoots(document);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
