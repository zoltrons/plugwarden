// The part of autofill that touches the page, in the content scripts' isolated world: `page.js` runs before
// `content.js` in every frame, and the service worker injects it into a frame that does not have it yet.
// Deciding what a field is happens outside, in the autofill engine; see background/engine.ts.
import type { CollectedPageDetails } from "../shared/messages.ts";
import { type CollectMode, collectFrame, isElementVisible } from "./collector/collect-frame.ts";
import { deepAll, deepFields } from "./collector/shadow-dom.ts";
import { extractAriaLabel, extractExplicitLabels } from "./collector/tree-walker.ts";
import { executeFill } from "./executor/fill.ts";
import type { FillResult, PageLogin } from "./types.ts";

const TEXTISH = ["text", "email", "tel", "number", ""];
const OTP_HINT = /one.?time|otp|totp|2fa|mfa|verification|confirmation.?code|security.?code|captcha/;

/** The field the user last focused for a login (content.ts); its form is the one they mean. */
let focused: Element | undefined;

/**
 * A login the user typed. This runs on submit, when the page is about to navigate and there is no time to
 * ask anything outside the frame, so it decides locally.
 */
function readLogin(): PageLogin | null {
  // Read-only fields count: sites show the account name in one and only let the password be typed.
  const inputs = deepFields().filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && isElementVisible(el));
  const filled = inputs.filter((i) => i.type === "password" && i.value);
  const editable = filled.filter((i) => !i.readOnly);
  const passwords = editable.length ? editable : filled;
  // On change-password forms (current / new / repeat) take the new password.
  const pass = passwords.find((i) => i.autocomplete.toLowerCase().split(/\s+/).includes("new-password")) ?? passwords.at(-1);
  if (!pass) return null;
  const hint = (i: HTMLInputElement) => [i.name, i.id, i.placeholder, extractAriaLabel(i), extractExplicitLabels(i)].join(" ").toLowerCase();
  const before = inputs.slice(0, inputs.indexOf(pass)).filter((i) => TEXTISH.includes(i.type) && i.value && !OTP_HINT.test(hint(i)));
  // A form is the boundary again; outside one, the nearest filled field before the password is it.
  const user = pass.form ? before.filter((i) => i.form === pass.form).at(-1) : before.at(-1);
  return { url: location.href, username: user?.value ?? "", password: pass.value };
}

export const api = {
  /** Refuses a frame on another origin before it reads a single field. */
  collect(req: { origin: string; mode: CollectMode }): CollectedPageDetails | FillResult {
    if (location.origin !== req.origin) return { filled: false, reason: "origin" };
    return collectFrame(focused?.isConnected ? focused : undefined, req.mode);
  },
  /** What a focused field looks like to the engine. Only the content script calls this. */
  collectActive: (el: Element) => collectFrame(el, "ActiveFieldOnly"),
  setFocused(el: Element) {
    focused = el;
  },
  execute: executeFill,
  readLogin,
  hasPasswordField: () => deepAll(document, "input[type=password]").length > 0,
};

export type PageApi = typeof api;

(globalThis as { plugwarden?: PageApi }).plugwarden ??= api;
