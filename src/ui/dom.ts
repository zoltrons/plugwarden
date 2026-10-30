import type { FrameRequest, Request, Response } from "../shared/messages.ts";
import { icon } from "./icons.ts";

export const t = (key: string, ...subs: string[]): string => chrome.i18n.getMessage(key, subs) || key;

// Theme is a per-device UI preference (localStorage of the extension origin, shared by popup, panel and
// the in-page frames); applied before the first render to avoid a flash.
export const THEMES = ["system", "light", "dark"] as const;
export function savedTheme(): string {
  try {
    return localStorage.getItem("theme") ?? "system";
  } catch {
    return "system"; // blocked third-party storage (menu/bar frames inside websites)
  }
}
export function applyTheme(theme = savedTheme()) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
applyTheme();

/**
 * For frames the content script embeds in a website: ignore clicks unless the browser reports the frame
 * as really visible (IntersectionObserver v2: not transparent, transformed away or covered) for 300 ms,
 * so a page cannot hide it under the cursor and harvest a click (clickjacking).
 */
export function guardClicks(): void {
  let since = 0;
  new IntersectionObserver(
    (es) => {
      since = (es.at(-1) as { isVisible?: boolean }).isVisible ? since || Date.now() : 0;
    },
    // trackVisibility / delay are Chromium-only and missing from lib.dom.
    { threshold: 0.5, trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  ).observe(document.body);
  addEventListener(
    "click",
    (e) => {
      if (since && Date.now() - since >= 300) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
}

/** True in the side panel (sidepanel.html), false in the action popup or a tab. */
export const inPanel = document.body.classList.contains("panel");

export type Child = Node | string | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class" || k === "style" || k.startsWith("aria-") || k.startsWith("data-") || k === "for" || k === "role")
      el.setAttribute(k, String(v));
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/**
 * A <select> with the app's own label and chevron. Native select text cannot be aligned
 * reliably, so the real control is transparent on top of a plain text label.
 */
export function withChevron(control: HTMLSelectElement): HTMLElement {
  const text = h("span", { class: "select-value", "aria-hidden": "true" });
  const sync = () => (text.textContent = control.selectedOptions[0]?.textContent ?? "");
  sync();
  control.addEventListener("change", sync);
  control.addEventListener("input", sync);
  return h("span", { class: "select" }, text, control, icon("chevronDown"));
}

export async function send<T>(req: Request | FrameRequest): Promise<Response<T>> {
  try {
    return ((await chrome.runtime.sendMessage(req)) as Response<T> | undefined) ?? { ok: false, error: t("errNoReply") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
