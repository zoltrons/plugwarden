// Functions injected on demand with chrome.scripting.executeScript (isolated world, one frame).
// They are serialized with Function#toString, so each must be fully self-contained: no imports, no
// references to anything outside its own body.

export interface FillResult {
  filled: boolean;
  reason?: "origin" | "noFields" | "noMatch" | "locked" | "error";
}

/** Minimal login-form detection + fill, including open shadow roots. Refuses to fill if the frame navigated to another origin. */
export function fillLogin(expectedOrigin: string, username: string, password: string): FillResult {
  if (location.origin !== expectedOrigin) return { filled: false, reason: "origin" };
  const deep = (root: ParentNode): HTMLInputElement[] =>
    [...root.querySelectorAll("*")].flatMap((e) => [...(e instanceof HTMLInputElement ? [e] : []), ...(e.shadowRoot ? deep(e.shadowRoot) : [])]);
  const visible = (el: HTMLInputElement) => !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const inputs = deep(document).filter(visible);
  const pass = inputs.find((i) => i.type === "password");
  const isUser = (i: HTMLInputElement) =>
    ["text", "email", "tel", ""].includes(i.type) && !/search|captcha|otp|code/i.test(`${i.name} ${i.id} ${i.autocomplete}`);
  let user: HTMLInputElement | undefined;
  if (pass) {
    // Nearest username-like field before the password, preferring the same form.
    const before = inputs.slice(0, inputs.indexOf(pass)).filter(isUser);
    user = before.filter((i) => i.form === pass.form).at(-1) ?? before.at(-1);
  } else {
    // Username-first step of a two-step login.
    user = inputs.find((i) => /username|email/.test(i.autocomplete)) ?? inputs.find((i) => i.type === "email");
  }
  if (!pass && !user) return { filled: false, reason: "noFields" };
  const set = (el: HTMLInputElement, value: string) => {
    el.focus();
    // Native setter + events, so framework-controlled inputs (React etc.) see the change.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };
  if (user && username) set(user, username);
  if (pass && password) set(pass, password);
  return { filled: true };
}

/**
 * Page-load autofill: like fillLogin, but only into empty fields so a page that pre-filled or a
 * user who already typed is never overwritten (the official client's `onlyEmptyFields`).
 */
export function fillLoginIfEmpty(expectedOrigin: string, username: string, password: string): FillResult {
  if (location.origin !== expectedOrigin) return { filled: false, reason: "origin" };
  const deep = (root: ParentNode): HTMLInputElement[] =>
    [...root.querySelectorAll("*")].flatMap((e) => [...(e instanceof HTMLInputElement ? [e] : []), ...(e.shadowRoot ? deep(e.shadowRoot) : [])]);
  const visible = (el: HTMLInputElement) => !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const inputs = deep(document).filter(visible);
  const pass = inputs.find((i) => i.type === "password");
  // Like the clients: page load never fills a username-only step, and never a "new password" field
  // (sign-up / change-password forms).
  if (!pass || /new-password/.test(pass.autocomplete)) return { filled: false, reason: "noFields" };
  const isUser = (i: HTMLInputElement) =>
    ["text", "email", "tel", ""].includes(i.type) && !/search|captcha|otp|code/i.test(`${i.name} ${i.id} ${i.autocomplete}`);
  const user = inputs.slice(0, inputs.indexOf(pass)).filter(isUser).filter((i) => i.form === pass.form).at(-1) ?? inputs.slice(0, inputs.indexOf(pass)).filter(isUser).at(-1);
  let n = 0;
  const set = (el: HTMLInputElement | undefined, value: string) => {
    if (!el || !value || el.value !== "") return;
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    n++;
  };
  set(user, username);
  set(pass, password);
  return n ? { filled: true } : { filled: false, reason: "noFields" };
}

/**
 * Card / identity fill. `values` is keyed by autocomplete token (cc-number, given-name, …); fields
 * without an autocomplete attribute are matched by name/id hints.
 */
export function fillForm(expectedOrigin: string, values: Record<string, string>): FillResult {
  if (location.origin !== expectedOrigin) return { filled: false, reason: "origin" };
  type Field = HTMLInputElement | HTMLSelectElement;
  const deep = (root: ParentNode): Field[] =>
    [...root.querySelectorAll("*")].flatMap((e) => [
      ...(e instanceof HTMLInputElement || e instanceof HTMLSelectElement ? [e] : []),
      ...(e.shadowRoot ? deep(e.shadowRoot) : []),
    ]);
  const hints: [string, RegExp][] = [
    ["cc-number", /card.?num|cc.?num|cardnumber/],
    ["cc-csc", /cvc|cvv|csc|security.?code/],
    ["cc-name", /card.?holder|name.?on.?card|cc.?name/],
    ["cc-exp-month", /exp.*(month|mm)\b|^mm$/],
    ["cc-exp-year", /exp.*(year|yy)|^yy(yy)?$/],
    ["cc-exp", /expir|exp.?date|mm.?yy/],
    ["given-name", /first.?name|fname|given/],
    ["family-name", /last.?name|lname|surname|family/],
    ["postal-code", /zip|postal|postcode/],
    ["address-level2", /city|town/],
    ["address-line1", /address.?1|street|address$/],
    ["tel", /phone|mobile|tel/],
  ];
  let n = 0;
  for (const el of deep(document)) {
    if (el.disabled || (el instanceof HTMLInputElement && (el.readOnly || el.type === "hidden" || el.type === "password")) || !el.getClientRects().length) continue;
    const ac = el.autocomplete.toLowerCase().split(/\s+/).pop() ?? "";
    const hint = `${el.name} ${el.id} ${el.getAttribute("aria-label") ?? ""}`.toLowerCase();
    const key = values[ac] ? ac : hints.find(([k, re]) => values[k] && re.test(hint))?.[0];
    const v = key ? values[key] : undefined;
    if (!v) continue;
    if (el instanceof HTMLSelectElement) {
      const opt = [...el.options].find((o) => o.value === v || o.text.trim() === v || (/^\d+$/.test(v) && Number(o.value) === Number(v)) || (v.length === 4 && o.value === v.slice(2)));
      if (!opt) continue;
      el.value = opt.value;
    } else Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    n++;
  }
  return n ? { filled: true } : { filled: false, reason: "noFields" };
}

export interface PageLogin {
  url: string;
  username: string;
  password: string;
}

/** Reads a typed-in login from the page: the popup's "save login" and the content script's save offer. */
export function readLogin(): PageLogin | null {
  const inputs = [...document.querySelectorAll("input")];
  const passwords = inputs.filter((i) => i.type === "password" && i.value);
  // On change-password forms (current / new / repeat) take the new password.
  const pass = passwords.find((i) => i.autocomplete === "new-password") ?? passwords.at(-1);
  if (!pass) return null;
  const before = inputs.slice(0, inputs.indexOf(pass)).filter((i) => ["text", "email", "tel", ""].includes(i.type) && i.value);
  const user = before.filter((i) => i.form === pass.form).at(-1) ?? before.at(-1);
  return { url: location.href, username: user?.value ?? "", password: pass.value };
}
