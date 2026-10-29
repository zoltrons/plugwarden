// Functions injected on demand with chrome.scripting.executeScript (isolated world, top frame only).
// They are serialized with Function#toString, so each must be fully self-contained: no imports, no
// references to anything outside its own body.

export interface FillResult {
  filled: boolean;
  reason?: "origin" | "noFields" | "noMatch" | "locked" | "error";
}

/** Minimal login-form detection + fill. Refuses to fill if the frame navigated to another origin. */
export function fillLogin(expectedOrigin: string, username: string, password: string): FillResult {
  if (location.origin !== expectedOrigin) return { filled: false, reason: "origin" };
  const visible = (el: HTMLInputElement) => !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const inputs = [...document.querySelectorAll("input")].filter(visible);
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
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (user && username) set(user, username);
  if (pass && password) set(pass, password);
  return { filled: true };
}

export interface PageLogin {
  url: string;
  username: string;
  password: string;
}

/** Reads a typed-in login from the page so the user can save it ("save login" without a content script). */
export function readLogin(): PageLogin | null {
  const inputs = [...document.querySelectorAll("input")];
  const pass = inputs.find((i) => i.type === "password" && i.value);
  if (!pass) return null;
  const before = inputs.slice(0, inputs.indexOf(pass)).filter((i) => ["text", "email", "tel", ""].includes(i.type) && i.value);
  const user = before.filter((i) => i.form === pass.form).at(-1) ?? before.at(-1);
  return { url: location.href, username: user?.value ?? "", password: pass.value };
}
