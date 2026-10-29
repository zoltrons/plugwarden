import type { Request, Response } from "../shared/messages.ts";

export const t = (key: string, ...subs: string[]): string => chrome.i18n.getMessage(key, subs) || key;

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

export async function send<T>(req: Request): Promise<Response<T>> {
  try {
    return ((await chrome.runtime.sendMessage(req)) as Response<T> | undefined) ?? { ok: false, error: t("errNoReply") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
