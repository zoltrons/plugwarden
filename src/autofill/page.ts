// The functions below are injected on demand with chrome.scripting.executeScript (isolated world, one
// frame), serialized with Function#toString: everything they use must be declared inside them, never at
// module level. `readLogin` is also imported by the content script, where imports do work.

export interface FillResult {
  filled: boolean;
  reason?: "origin" | "noFields" | "noMatch" | "locked" | "error";
}

export interface PageLogin {
  url: string;
  username: string;
  password: string;
}

export interface LoginFill {
  mode: "login";
  /** The frame navigated away from this origin: never fill there. */
  origin: string;
  username: string;
  password: string;
  /** Page load: only empty fields, never a username-only step or a new/confirm password. */
  onlyEmpty?: boolean;
  /** Skip the username-first step: fill only a form that has a password field. */
  passwordOnly?: boolean;
}

export interface FormFill {
  mode: "form";
  origin: string;
  /** Card / identity values keyed by HTML autocomplete token (cc-number, given-name, …). */
  values: Record<string, string>;
}

export interface ReadFill {
  mode: "read";
}

export type FillRequest = LoginFill | FormFill | ReadFill;

/** Login / card fill, or a login read, for one page frame. Injected: everything it uses lives below. */
export function fillInPage(req: FillRequest): FillResult | PageLogin | null {
  const OTP_HINT = /one.?time|otp|totp|2fa|mfa|verification|confirmation.?code|security.?code|captcha/;
  const SKIP_HINT = /search|newsletter|subscribe|promo|coupon|gift.?card|quantity/;
  const USER_HINT = /user|logon|login|sign.?in|e-?mail|mail|account|acct|identifier|customer|member|client|usr|uname|handle|nick|correo|benutzer|usuario|utilisateur|utente|gebruiker/;
  const PASS_HINT = /pass|pwd|pin/;
  const NEW_HINT = /new|confirm|repeat|retype|regis|sign.?up|create|join/;
  const SIGNUP_FORM = /sign.?up|register|create.?account|new.?account|join now/;
  const CONFIRM_HINT = /confirm|repeat|retype|again|verify|tekrar/;
  const TEXTISH = ["text", "email", "tel", ""];
  const AUTOFILL_RULES: [string, RegExp][] = [
    ["cc-number", /card.?(num|number)|cc.?(num|number)|cardnumber/],
    ["cc-csc", /cvc|cvv|csc|security.?code/],
    ["cc-name", /card.?holder|name.?(on|of).?card|cc.?name/],
    ["cc-exp-month", /exp.*(month|\bmm\b)|(^|\W)month/],
    ["cc-exp-year", /exp.*(year|\byy|yyyy)|(^|\W)year/],
    ["cc-exp", /expir|exp.?(date|iration)|valid.?thru|\bmm.?(yy|yyyy)\b/],
    ["cc-type", /card.?type|brand/],
    ["given-name", /first.?name|fname|given/],
    ["additional-name", /middle.?name|mname/],
    ["family-name", /last.?name|lname|surname|family/],
    ["name", /full.?name|(^|\W)name($|\W)|your.?name/],
    ["email", /e-?mail/],
    ["tel", /phone|mobile|tel\b/],
    ["organization", /company|organi[sz]ation/],
    ["address-line1", /address.?(1|line.?1)|street/],
    ["street-address", /street|address/],
    ["address-level2", /city|town/],
    ["address-level1", /state|province|region|county/],
    ["postal-code", /zip|postal|postcode/],
    ["country", /country/],
  ];

  type Field = HTMLInputElement | HTMLSelectElement;

  /** Every field of the document, open shadow roots included, in document order. */
  const deep = (root: ParentNode, out: Field[] = []): Field[] => {
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) out.push(el);
      if (el.shadowRoot) deep(el.shadowRoot, out);
    }
    return out;
  };
  /** False for fields nobody can see: zero-size decoys are a favourite of login pages. */
  const shown = (el: Field) => {
    if (el.disabled || (el instanceof HTMLInputElement && el.type === "hidden")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 8) return false;
    // Off the page's origin (document coordinates, so scrolled-away fields still count): unreachable decoys.
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return false;
    // Parked far to the right of the viewport, or clipped away: a trap field, not a form.
    if (r.left >= innerWidth || getComputedStyle(el).clipPath !== "none") return false;
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  /** A field a fill may write to: shown, and not a read-only copy the page only displays. */
  const onScreen = (el: Field) => shown(el) && !(el instanceof HTMLInputElement && el.readOnly);
  /** Everything that can name a field: its attributes, its label(s) and aria-labelledby text. */
  const hints = (el: Field) => {
    const parts = [el.name, el.id, el instanceof HTMLInputElement ? el.placeholder : "", el.getAttribute("aria-label") ?? ""];
    for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/)) if (id) parts.push(el.ownerDocument.getElementById(id)?.textContent ?? "");
    for (const l of el.labels ?? []) parts.push(l.textContent ?? "");
    return parts.join(" ").toLowerCase();
  };
  /** Writes through the prototype setter, so framework-controlled inputs see the change. */
  const setNative = (el: HTMLInputElement, value: string) => {
    for (let p: object | null = Object.getPrototypeOf(el); p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, "value");
      if (d?.set) return void d.set.call(el, value);
    }
    el.value = value;
  };
  /** Fills the way typing looks to a page: click, focus, key events, value, input, change. */
  const write = (el: Field, value: string) => {
    el.focus();
    if (el instanceof HTMLSelectElement) {
      el.value = value;
    } else {
      el.click();
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Unidentified" }));
      setNative(el, value);
      el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    if (el instanceof HTMLInputElement) el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };

  if (req.mode === "read") {
    // Read-only fields count: sites show the account name in one and only let the password be typed.
    const inputs = deep(document).filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && shown(el));
    const filled = inputs.filter((i) => i.type === "password" && i.value);
    const editable = filled.filter((i) => !i.readOnly);
    const passwords = editable.length ? editable : filled;
    // On change-password forms (current / new / repeat) take the new password.
    const pass = passwords.find((i) => i.autocomplete.toLowerCase().split(/\s+/).includes("new-password")) ?? passwords.at(-1);
    if (!pass) return null;
    const before = inputs.slice(0, inputs.indexOf(pass)).filter((i) => TEXTISH.includes(i.type) && i.value && !OTP_HINT.test(hints(i)));
    // A form is the boundary again; outside one, the nearest filled field before the password is it.
    const user = pass.form ? before.filter((i) => i.form === pass.form).at(-1) : before.at(-1);
    return { url: location.href, username: user?.value ?? "", password: pass.value };
  }

  if (location.origin !== req.origin) return { filled: false, reason: "origin" };

  if (req.mode === "form") {
    let n = 0;
    for (const el of deep(document)) {
      if (!onScreen(el)) continue;
      const ac = el.autocomplete.toLowerCase().split(/\s+/).pop() ?? "";
      const hint = hints(el);
      const key = req.values[ac] ? ac : AUTOFILL_RULES.find(([k, re]) => req.values[k] && re.test(hint))?.[0];
      let v = key ? req.values[key] : undefined;
      if (!key || !v) continue;
      // A formatted card number does not fit a narrow field and breaks digit masks.
      if (key === "cc-number" && el instanceof HTMLInputElement && el.maxLength > 11 && el.maxLength < 25) v = v.replace(/\D/g, "");
      if (el instanceof HTMLSelectElement) {
        const opt = [...el.options].find((o) => o.value === v || o.text.trim() === v || (/^\d+$/.test(v) && Number(o.value) === Number(v)));
        if (!opt) continue;
        write(el, opt.value);
      } else write(el, v);
      n++;
    }
    return n ? { filled: true } : { filled: false, reason: "noFields" };
  }

  // weight ranks how strongly a field names itself as an account identifier; 0 = no hint at all.
  type Login = { el: HTMLInputElement; kind: "user" | "text" | "pass" | "new" | ""; weight: number };
  const fields = deep(document)
    .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && onScreen(el))
    .map((el): Login => {
      const ac = el.autocomplete.toLowerCase().split(/\s+/);
      const hint = hints(el);
      const fresh = ac.includes("new-password") || (!ac.includes("current-password") && NEW_HINT.test(hint));
      if (el.type === "password") {
        const weight = (fresh ? 0 : 10) + (ac.includes("current-password") ? 20 : 0) + (PASS_HINT.test(hint) ? 2 : 0);
        return { el, kind: fresh ? "new" : "pass", weight };
      }
      if (!TEXTISH.includes(el.type) || OTP_HINT.test(hint) || SKIP_HINT.test(hint)) return { el, kind: "", weight: 0 };
      const weight =
        (ac.includes("username") ? 8 : 0) + (ac.includes("email") ? 6 : 0) + (el.type === "email" ? 4 : 0) + (USER_HINT.test(hint) ? 3 : 0) + (el.type === "tel" ? 1 : 0);
      return { el, kind: weight ? "user" : "text", weight };
    });

  // Document order, and the block two fields share: a password and its username live in one.
  const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const sharedBlock = (a: Element, b: Element) => {
    const seen = new Set<Element>();
    for (let p: Element | null = a; p; p = p.parentElement) seen.add(p);
    for (let p: Element | null = b; p; p = p.parentElement) if (seen.has(p)) return p;
    return document.body; // disjoint trees (shadow roots) count as page-wide, like a shared <body>
  };

  // Named inputs clobber form.innerText / form.textContent with elements: only trust strings.
  const formText = (form: HTMLFormElement) => {
    const t = [form.innerText, form.textContent].find((v) => typeof v === "string");
    return (t as string | undefined)?.toLowerCase() ?? "";
  };
  const candidates = fields.filter((f) => f.kind === "user" || f.kind === "text");
  // A login form beats a registration form, and a current password beats a new one.
  const pass = fields
    .filter((f) => f.kind === "pass" || f.kind === "new")
    .map((f) => {
      const form = f.el.form;
      let score = f.weight;
      if (form) score += 2;
      if (form && SIGNUP_FORM.test(formText(form))) score -= 12;
      if (candidates.some((u) => u.el.form === form && before(u.el, f.el))) score += 6;
      return { f, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.f;

  /** The username of a login form: the best-named field in the same form (or block), before the password. */
  const pick = (list: Login[]) =>
    list
      .map((u, i) => ({ u, i, pre: pass ? before(u.el, pass.el) : false }))
      .sort((a, b) => b.u.weight - a.u.weight || Number(b.pre) - Number(a.pre) || b.i - a.i)[0]?.u;

  let user: Login | undefined;
  if (pass) {
    user = pass.el.form
      ? // A form is the boundary: typing a username into another form's field is never right.
        pick(candidates.filter((u) => u.el.form === pass.el.form))
      : // No form at all: only a field in the same block, never a page-wide search or subscribe box.
        pick(candidates.filter((u) => !u.el.form && sharedBlock(u.el, pass.el) !== document.body));
  } else if (!req.onlyEmpty && !req.passwordOnly) {
    // Username-first step (the password comes on the next page): only a field that names itself.
    user = pick(candidates.filter((u) => u.kind === "user"));
  }
  // Page load never fills a username-only step or a new/confirm password.
  if (req.onlyEmpty && (!pass || pass.kind === "new")) return { filled: false, reason: "noFields" };
  if (!pass && !user) return { filled: false, reason: "noFields" };

  let n = 0;
  const fill = (el: HTMLInputElement | undefined, value: string) => {
    if (!el || !value || (req.onlyEmpty && el.value !== "")) return;
    write(el, value);
    n++;
  };
  fill(user?.el, req.username);
  fill(pass?.el, req.password);
  // A registration form repeats the password, and a confirm field left empty blocks its submit.
  if (pass && !req.onlyEmpty) {
    const next = fields.find((f) => (f.kind === "pass" || f.kind === "new") && f.el.form === pass.el.form && before(pass.el, f.el));
    if (next && ((pass.kind === "new" && next.kind === "new") || CONFIRM_HINT.test(hints(next.el)))) fill(next.el, req.password);
  }
  return n || !req.onlyEmpty ? { filled: true } : { filled: false, reason: "noFields" };
}

/**
 * True for a field of a registration form. A password field is required: a lone "Sign up" is as often a
 * newsletter box. Attributes and the submit button only, since login forms often link to "Sign up".
 * shortcut: email-first signups (password on the next step) are not recognised, add a signal if they matter.
 */
export function isSignupField(el: HTMLInputElement): boolean {
  const form = el.form;
  // A named input ("querySelector") clobbers the form's own methods: call the native ones.
  const all = (sel: string) => [...(form ? Element.prototype.querySelectorAll.call(form, sel) : (el.getRootNode() as ParentNode).querySelectorAll(sel))];
  const ac = (all("input[type=password]") as HTMLInputElement[]).map((p) => p.autocomplete.toLowerCase());
  if (!ac.length || ac.some((a) => a.includes("current-password"))) return false;
  if (ac.length > 1 || ac.some((a) => a.includes("new-password"))) return true;
  if (!form) return false;
  const attrs = ["id", "name", "action"].map((a) => Element.prototype.getAttribute.call(form, a) ?? "");
  const buttons = (all("button:not([type=button],[type=reset]),input[type=submit]") as HTMLButtonElement[]).map((b) => b.textContent || b.value);
  return /sign.?up|regist|create.?(an.?|your.?)?account|new.?account|join|kay[iı]t|kaydol|üye ol|hesap oluştur/.test([...attrs, ...buttons].join(" ").toLowerCase());
}

/** The content script's copy: reads a typed-in login without being injected. */
export const readLogin = (): PageLogin | null => fillInPage({ mode: "read" }) as PageLogin | null;
