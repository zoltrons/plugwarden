#!/usr/bin/env node
// Field-detection smoke test: runs page.js against fixture pages in Helium or Chromium and the autofill
// engine (dist/wasm) here in Node, no extension host and no server needed. Covers the login/card rules the
// autofill path depends on (decoys, registration-vs-login, labels, forms, shadow roots, page load).
//   node tools/smoke-fill.mjs        HEADED=1 to watch it
import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = await import(join(root, "dist/wasm/autofill_core.js"));
engine.initSync({ module: readFileSync(join(root, "dist/wasm/autofill_core_bg.wasm")) });
const bundle = (
  await build({
    absWorkingDir: root,
    entryPoints: ["src/autofill/page.ts"],
    bundle: true,
    write: false,
    format: "iife",
    target: "chrome120",
    logLevel: "warning",
  })
).outputFiles[0].text;

const signup = `<form onsubmit="return false">
  <input id="su-email" autocomplete="email"><input id="su-pass" type="password" autocomplete="new-password"><button>Create account</button>
</form>
<form onsubmit="return false">
  <input id="u" name="login" autocomplete="username"><input id="p" type="password" autocomplete="current-password"><button>Sign in</button>
</form>`;

const fixtures = {
  // Zero-size password decoys sit in front of the real form on anti-autofill pages.
  decoy: `<input id="decoy" type="password" style="position:absolute;width:0;height:0;opacity:0;border:0">
    <form onsubmit="return false"><input id="u" name="username"><input id="p" type="password" name="password"><button>Sign in</button></form>`,
  // A registration form before the login one: the login must win, the registration stay empty.
  signup,
  // Registration forms: a repeated password; only the submit button or the form's attributes say so.
  register: `<form onsubmit="return false"><input id="u" type="email"><input id="p" type="password" name="password">
    <input id="p2" type="password" name="password2" placeholder="Confirm password"><button>Create account</button></form>`,
  signupButton: `<form onsubmit="return false"><input id="u" name="email"><input id="p" type="password"><button>Kayıt ol</button></form>`,
  loginLink: `<form onsubmit="return false"><input id="u" name="email"><input id="p" type="password"><a href="/x">Sign up</a><button>Sign in</button></form>`,
  newsletter: `<form onsubmit="return false"><input id="u" type="email"><button>Sign up</button></form>`,
  // A component library: every input in a shadow root of its own, no form.
  splitShadow: `<div id="login"><x-a></x-a><x-b></x-b></div><script>
    document.querySelector("x-a").attachShadow({ mode: "open" }).innerHTML = '<input id="u" type="email">';
    document.querySelector("x-b").attachShadow({ mode: "open" }).innerHTML = '<input id="p" type="password">';
  </script>`,
  // Two login forms: the one the user is in wins.
  twoForms: `<form id="a" onsubmit="return false"><input id="u1" name="username"><input id="p1" type="password"></form>
    <form id="b" onsubmit="return false"><input id="u2" name="username"><input id="p2" type="password"></form>`,
  // Only a <div> says what the field is.
  bareLabels: `<form onsubmit="return false"><div>Card number</div><div><input id="c"></div><div>CVC</div><div><input id="v"></div></form>
    <form onsubmit="return false"><p>E-posta adresiniz</p><input id="tu"><p>Parola</p><input id="tp" type="password"></form>`,
  // A lone "*" is not a label; the label may also sit behind the input, or outside its shadow root.
  starLabel: `<form onsubmit="return false"><div>Card number <span>*</span></div><input id="c"></form>`,
  labelAfter: `<form onsubmit="return false"><div><input id="c"><span>Card number</span></div><div><input id="v"><span>CVC</span></div>
    <div><input id="n"><span>CVC</span><input id="other"></div><div><input id="f"><a href="/x">Card number help</a></div></form>`,
  namedHost: `<img name="host"><form onsubmit="return false"><input id="c"></form><div><input id="u" placeholder="Email"><input id="p" type="password"></div>`,
  dataLabel: `<form onsubmit="return false"><input id="c" data-label="Card number"></form>`,
  otherForm: `<form onsubmit="return false"><span>Card number</span></form><input id="c">`,
  shadowLabel: `<form onsubmit="return false"><span>Card number</span><x-a></x-a></form><script>
    document.querySelector("x-a").attachShadow({ mode: "open" }).innerHTML = '<input id="c">';
  </script>`,
  hiddenLabel: `<form onsubmit="return false"><span style="display:none">Card number</span><input id="c"></form>`,
  // Registers an own "value" property on the input the way React's value tracker does: a plain
  // el.value = x goes through it and the framework never notices the change.
  controlled: `<form onsubmit="return false"><input id="u" name="username"><input id="p" type="password"></form><script>
    window.state = {};
    for (const el of document.querySelectorAll("input")) {
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      let tracked = "";
      Object.defineProperty(el, "value", { configurable: true, get() { return proto.get.call(this); }, set(v) { tracked = v; proto.set.call(this, v); } });
      el.addEventListener("input", () => { if (el.value !== tracked) { tracked = el.value; state[el.id] = el.value; } });
    }
  </script>`,
  dark: `<body style="background:#111"><form onsubmit="return false"><input id="u" name="username" style="background:transparent"><input id="p" type="password" style="background:#fff"></form>`,
  address: `<form onsubmit="return false"><label for="a">Street address</label><textarea id="a"></textarea><label for="e">Email us about your name</label><textarea id="e"></textarea></form>`,
  otp: `<form onsubmit="window.submitted=true;return false"><label for="code">Verification code</label><input id="code" autocomplete="off"><button>Verify</button></form>`,
  twoStep: `<form onsubmit="return false"><input id="u" name="username"><div id="step2" style="display:none"><input id="p" type="password" name="password"></div><button>Next</button></form>`,
  autosubmit: `<form onsubmit="return false"><input id="u" name="username"><input id="p" type="password" name="password">
    <button type="button" id="show">Show password</button><button id="go" onclick="window.submitted='button'">Sign in</button></form>`,
  autosubmitEnter: `<form onsubmit="window.submitted='enter';return false"><input id="u" name="username"><input id="p" type="password" name="password"></form>`,
  cardShapes: `<form onsubmit="return false"><input id="c" autocomplete="cc-number" maxlength="19"><input id="compact" autocomplete="cc-exp" maxlength="4">
    <input id="long" autocomplete="cc-exp" placeholder="MM/YYYY"><input id="year" autocomplete="cc-exp-year" maxlength="2"></form>`,
  long: `<form>${"x".repeat(3000)}<input name="${"n".repeat(1000)}"></form>`,
  // Boxes that must never take a username, right before the password; autocomplete=off changes nothing.
  avoid: `<form onsubmit="return false"><input id="q" name="q"><input id="coupon" name="discount_code"><input id="trap" aria-hidden="true" name="username">
    <input id="p" type="password" autocomplete="off"></form>`,
  acOff: `<form onsubmit="return false"><input id="u" name="username" autocomplete="off"><input id="p" type="password" autocomplete="off"></form>`,
  // Two-step login: one account field, no password anywhere.
  useronly: `<form onsubmit="return false"><input id="u" name="login" placeholder="Email or phone"><button>Next</button></form>`,
  // Nothing but labels and placeholders to go on.
  labels: `<form onsubmit="return false">
    <label for="u">Email address</label><input id="u">
    <label for="p">Password</label><input id="p" type="password"><button>Log in</button></form>`,
  // A password-only re-authentication next to an unrelated subscribe box.
  nouser: `<div><input id="news" placeholder="Your email for our newsletter"><button>Subscribe</button></div>
    <form onsubmit="return false"><input id="p" type="password" placeholder="Confirm your password"><button>Unlock</button></form>`,
  // The same, but with the login fields in a form-less dialog block.
  modal: `<div><input id="news" placeholder="Your email for our newsletter"></div>
    <div class="dialog"><input id="u" placeholder="Email"><input id="p" type="password"><button>Sign in</button></div>`,
  // Login form inside an open shadow root.
  shadow: `<div id="host"></div><script>
    document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
      '<form onsubmit="return false"><input id="u" name="username"><input id="p" type="password" name="password"><button>Sign in</button></form>';
  </script>`,
  // A read-only account field (the site only lets the password be typed) and a change-password form.
  readonly: `<form onsubmit="return false"><input id="u" value="shown@example.com" readonly><input id="p" type="password"><button>Sign in</button></form>`,
  change: `<form onsubmit="return false"><input id="u" autocomplete="username">
    <input id="cur" type="password" autocomplete="current-password">
    <input id="new" type="password" autocomplete="new-password">
    <input id="rep" type="password"></form>`,
  // Card form with labels only: no autocomplete, no useful name or id.
  card: `<form onsubmit="return false">
    <label for="n">Name on card</label><input id="n">
    <label for="c">Card number</label><input id="c">
    <select id="m" aria-label="Expiry month"><option></option><option>01</option><option>02</option></select>
    <input id="y" placeholder="Expiry year">
    <input id="v" aria-label="Security code"></form>`,
};

const server = createServer((req, res) => {
  const key = new URL(req.url, "http://x").pathname.slice(1);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>${key}</title><body>${fixtures[key] ?? ""}`, "utf8");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// The extension targets Chromium: HELIUM_PATH, else Helium on this machine, else Playwright's Chromium (CI).
const helium = process.env.HELIUM_PATH ?? join(homedir(), "Applications/Helium.app/Contents/MacOS/Helium");
const executablePath = existsSync(helium) ? helium : chromium.executablePath();
const browser = await chromium.launch({ executablePath, headless: !process.env.HEADED });
const errors = [];
let pass = 0;

const values = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...(function walk(root, out) {
        for (const el of root.querySelectorAll("input, select, textarea")) {
          out.push(el);
          if (el.shadowRoot) walk(el.shadowRoot, out);
        }
        return out;
      })(document, [])].map((el) => [el.id || el.placeholder || el.tagName, el.value]),
    ),
  );

async function scenario(name, key, fn) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/${key}`);
  await page.addScriptTag({ content: bundle });
  try {
    await fn(page);
    pass++;
    console.log(`✔ ${name}`);
  } catch (e) {
    console.log(`✘ ${name}`);
    throw e;
  } finally {
    await page.close();
  }
}

const collect = (page, origin) => page.evaluate((origin) => plugwarden.collect({ origin: origin ?? location.origin, mode: "FullPage" }), origin);

/** What background/engine.ts does for one frame: collect, plan, and write the values the plan names. */
async function run(page, intent, valueOf, onlyEmpty, origin) {
  const details = await collect(page, origin);
  if (typeof details.filled === "boolean") return details;
  const plan = JSON.parse(engine.plan(JSON.stringify({ details, intent })));
  if (!plan.ops.length) return { filled: false, reason: "noFields" };
  const ops = plan.ops.map((o) => ({ fieldId: o.fieldId, value: valueOf(o.source), format: o.format })).filter((o) => o.value);
  return page.evaluate((req) => plugwarden.execute({ ...req, origin: location.origin }), { ops, onlyEmpty, submit: plan.submit });
}

const fill = (page, { username = "user@example.com", password = "pa55word", onlyEmpty = false, passwordOnly = false, totp, autosubmit = false, origin } = {}) =>
  run(page, { kind: "login", onlyEmpty, passwordOnly, hasTotp: !!totp, autosubmit }, (s) => ({ username, password, totp })[s], onlyEmpty, origin);

const formFill = (page, values) => run(page, { kind: "form", keys: Object.keys(values) }, (s) => values[s]);

const read = (page) => page.evaluate(() => plugwarden.readLogin());

/** The engine's verdict on field `id`, as if the user had just focused it. */
const analyzed = async (page, id) => {
  const details = await page.evaluate((id) => plugwarden.collectActive(document.getElementById(id)), id);
  const fieldId = details.fields.find((f) => f.isActive).fieldId;
  return { field: details.fields.find((f) => f.isActive), ...JSON.parse(engine.analyze_page(JSON.stringify(details))).fields.find((f) => f.fieldId === fieldId) };
};

const focusOn = (page, id) => page.evaluate((id) => plugwarden.setFocused(document.getElementById(id)), id);

await scenario("a zero-size password decoy is skipped", "decoy", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.decoy, v.u, v.p], ["", "user@example.com", "pa55word"]);
});

await scenario("the login form wins over a registration form", "signup", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v["su-email"], v["su-pass"], v.u, v.p], ["", "", "user@example.com", "pa55word"]);
});

await scenario("a username-first step is filled, and page load skips it", "useronly", async (page) => {
  assert.deepEqual(await fill(page, { onlyEmpty: true }), { filled: false, reason: "noFields" });
  // passwordOnly (the top-frame pass of a popup fill) leaves it alone, so a login in an iframe can win.
  assert.deepEqual(await fill(page, { passwordOnly: true }), { filled: false, reason: "noFields" });
  assert.equal((await values(page)).u, "");
  assert.deepEqual(await fill(page), { filled: true });
  assert.equal((await values(page)).u, "user@example.com");
});

await scenario("labels alone identify the fields", "labels", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["user@example.com", "pa55word"]);
});

await scenario("a page-wide subscribe box is never the username", "nouser", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.news, v.p], ["", "pa55word"]);
});

await scenario("form-less login blocks are paired, page-wide boxes are not", "modal", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.news, v.u, v.p], ["", "user@example.com", "pa55word"]);
});

await scenario("fields inside an open shadow root are filled and read back", "shadow", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const login = await read(page);
  assert.deepEqual([login.username, login.password], ["user@example.com", "pa55word"]);
});

await scenario("page load keeps what the page or the user already typed", "signup", async (page) => {
  await page.evaluate(() => (document.getElementById("p").value = "typed-pass"));
  assert.deepEqual(await fill(page, { onlyEmpty: true }), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["user@example.com", "typed-pass"]);
  // Both fields full: nothing left to fill, and nothing overwritten.
  assert.deepEqual(await fill(page, { onlyEmpty: true }), { filled: false, reason: "noFields" });
});

await scenario("page load never fills a new password", "signup", async (page) => {
  await page.evaluate(() => (document.getElementById("u").value = ""));
  // Only the registration form is left: a page load must not fill it.
  await page.evaluate(() => document.querySelectorAll("form")[1].remove());
  assert.deepEqual(await fill(page, { username: "u", password: "p", onlyEmpty: true }), { filled: false, reason: "noFields" });
});

await scenario("a read-only account field still names the login", "readonly", async (page) => {
  await page.fill("#p", "typed-pass");
  const login = await read(page);
  assert.deepEqual([login.username, login.password], ["shown@example.com", "typed-pass"]);
});

await scenario("a change-password form reports the new password", "change", async (page) => {
  for (const [id, value] of [["u", "bar-user"], ["cur", "old-pass"], ["new", "new-pass"], ["rep", "new-pass"]]) await page.fill(`#${id}`, value);
  const login = await read(page);
  assert.deepEqual([login.username, login.password], ["bar-user", "new-pass"]);
});

await scenario("card fields are found by their labels and placeholders", "card", async (page) => {
  const r = await formFill(page, { "cc-name": "Ada L", "cc-number": "4111111111111111", "cc-exp-month": "01", "cc-exp-year": "2030", "cc-csc": "123" });
  assert.deepEqual(r, { filled: true });
  const v = await values(page);
  assert.deepEqual([v.n, v.c, v.m, v.y, v.v], ["Ada L", "4111111111111111", "01", "2030", "123"]);
});

await scenario("a frame on another origin is refused", "decoy", async (page) => {
  const r = await fill(page, { origin: "https://elsewhere.example", username: "u", password: "p" });
  assert.deepEqual(r, { filled: false, reason: "origin" });
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["", ""]);
});
await scenario("a login split over two shadow roots is paired", "splitShadow", async (page) => {
  assert.deepEqual(await fill(page), { filled: true });
  const v = await page.evaluate(() => ["x-a", "x-b"].map((t) => document.querySelector(t).shadowRoot.querySelector("input").value));
  assert.deepEqual(v, ["user@example.com", "pa55word"]);
});

await scenario("the form with the focused field wins", "twoForms", async (page) => {
  await focusOn(page, "u2");
  await fill(page);
  const v = await values(page);
  assert.deepEqual([v.u1, v.p1, v.u2, v.p2], ["", "", "user@example.com", "pa55word"]);
});

await scenario("a page-load fill ignores the focused field", "twoForms", async (page) => {
  await focusOn(page, "u2");
  await fill(page, { onlyEmpty: true });
  const v = await values(page);
  assert.deepEqual([v.u2, v.p2], ["", ""]);
});

await scenario("the text before an unlabelled field names it", "bareLabels", async (page) => {
  const r = await formFill(page, { "cc-number": "4111111111111111", "cc-csc": "123" });
  assert.deepEqual(r, { filled: true });
  const v = await values(page);
  assert.deepEqual([v.c, v.v, v.tu], ["4111111111111111", "123", ""]);
  assert.match((await analyzed(page, "tu")).field.labelBefore, /E-posta/);
});

const cardFill = (page) => formFill(page, { "cc-number": "4111", "cc-csc": "123" });

await scenario("a lone asterisk does not hide the label before it", "starLabel", async (page) => {
  assert.deepEqual(await cardFill(page), { filled: true });
  assert.equal((await values(page)).c, "4111");
});

await scenario("text behind a field names it only when the field is alone in its parent", "labelAfter", async (page) => {
  await cardFill(page);
  const v = await values(page);
  // "CVC" between two fields in one parent names the second of them, never the first.
  assert.deepEqual([v.c, v.v, v.n, v.other, v.f], ["4111", "123", "", "123", ""]);
});

await scenario("an element named host does not hang the walk up the tree", "namedHost", async (page) => {
  await fill(page);
  assert.equal((await values(page)).p, "pa55word");
  await cardFill(page);
});

await scenario("data-label names a field", "dataLabel", async (page) => {
  await cardFill(page);
  assert.equal((await values(page)).c, "4111");
});

await scenario("another form's text is not a label", "otherForm", async (page) => {
  assert.deepEqual(await cardFill(page), { filled: false, reason: "noFields" });
});

await scenario("a label outside the input's shadow root names it", "shadowLabel", async (page) => {
  assert.deepEqual(await cardFill(page), { filled: true });
  assert.equal(await page.evaluate(() => document.querySelector("x-a").shadowRoot.querySelector("input").value), "4111");
});

await scenario("invisible text is not a label", "hiddenLabel", async (page) => {
  assert.deepEqual(await cardFill(page), { filled: false, reason: "noFields" });
});

await scenario("a framework-controlled input sees the fill", "controlled", async (page) => {
  await fill(page);
  assert.deepEqual(await page.evaluate(() => window.state), { u: "user@example.com", p: "pa55word" });
});

await scenario("a filled field is marked for its background until it is edited", "dark", async (page) => {
  await fill(page);
  const mark = (id) => page.evaluate((id) => document.getElementById(id).getAttribute("data-pw-autofilled"), id);
  assert.deepEqual([await mark("u"), await mark("p")], ["dark", "light"]);
  await page.type("#u", "x");
  assert.equal(await mark("u"), null);
  assert.equal(await page.evaluate(() => document.getElementById("u").style.outline), "");
  // A second fill marks it again, with one listener left.
  await fill(page);
  assert.equal(await mark("u"), "dark");
});

await scenario("a textarea takes an address, and nothing else", "address", async (page) => {
  await formFill(page, { "street-address": "1 Main St", email: "a@b.c", name: "Ada" });
  const v = await values(page);
  assert.deepEqual([v.a, v.e], ["1 Main St", ""]);
});

await scenario("search, coupon and aria-hidden boxes never take the username", "avoid", async (page) => {
  await fill(page);
  const v = await values(page);
  assert.deepEqual([v.q, v.coupon, v.trap, v.p], ["", "", "", "pa55word"]);
  assert.equal((await analyzed(page, "q")).avoid, true);
});

await scenario("autocomplete=off does not stop a fill", "acOff", async (page) => {
  await fill(page);
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["user@example.com", "pa55word"]);
});

const isSignup = async (page, id = "u") => !!(await analyzed(page, id)).signup;

await scenario("a registration form is recognised and its confirm field filled", "register", async (page) => {
  assert.equal(await isSignup(page), true);
  assert.deepEqual(await fill(page), { filled: true });
  const v = await values(page);
  assert.deepEqual([v.u, v.p, v.p2], ["user@example.com", "pa55word", "pa55word"]);
});

await scenario("a submit button can name a registration form, in Turkish too", "signupButton", async (page) => {
  assert.equal(await isSignup(page), true);
});

await scenario("a login form that links to sign up is not a registration form", "loginLink", async (page) => {
  assert.equal(await isSignup(page), false);
});

await scenario("a newsletter box is not a registration form", "newsletter", async (page) => {
  assert.equal(await isSignup(page), false);
});

await scenario("new-password marks registration, current-password a login or change form", "signup", async (page) => {
  assert.equal(await isSignup(page, "su-email"), true);
  assert.equal(await isSignup(page), false);
});

await scenario("a change-password form leaves the new password alone", "change", async (page) => {
  assert.equal(await isSignup(page), false);
  await fill(page);
  const v = await values(page);
  assert.deepEqual([v.cur, v.new, v.rep], ["pa55word", "", ""]);
});

await scenario("autocomplete=off in a login form opens the menu and says so", "acOff", async (page) => {
  const f = await analyzed(page, "u");
  assert.deepEqual([f.menu, f.correctAutocompleteOff, f.requiresInteractionForMenu], ["login", true, true]);
});

await scenario("a lone one-time-code box takes the code of the login, only when it is focused", "otp", async (page) => {
  assert.equal((await analyzed(page, "code")).menu, "login");
  assert.deepEqual(await fill(page, { totp: "123456" }), { filled: false, reason: "noFields" });
  await focusOn(page, "code");
  assert.deepEqual(await fill(page, { totp: "123456", autosubmit: true }), { filled: true });
  assert.equal((await values(page)).code, "123456");
  assert.equal(await page.evaluate(() => window.submitted ?? false), false);
});

await scenario("a hidden password waits: only the username of a two-step form is filled", "twoStep", async (page) => {
  await fill(page);
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["user@example.com", ""]);
  assert.deepEqual(await page.evaluate(() => {
    document.getElementById("step2").style.display = "block";
    return plugwarden.hasPasswordField();
  }), true);
  await fill(page);
  assert.equal((await values(page)).p, "pa55word");
});

await scenario("a page that hides a field after collection does not get a value there", "decoy", async (page) => {
  const details = await collect(page);
  const plan = JSON.parse(engine.plan(JSON.stringify({ details, intent: { kind: "login" } })));
  await page.evaluate(() => (document.getElementById("p").style.display = "none"));
  const ops = plan.ops.map((o) => ({ fieldId: o.fieldId, value: "secret" }));
  await page.evaluate((ops) => plugwarden.execute({ origin: location.origin, ops }), ops);
  const v = await values(page);
  assert.deepEqual([v.u, v.p], ["secret", ""]);
});

await scenario("autosubmit clicks the login button", "autosubmit", async (page) => {
  await fill(page, { autosubmit: true });
  assert.equal(await page.evaluate(() => window.submitted), "button");
});

await scenario("without a login button autosubmit presses Enter and submits the form", "autosubmitEnter", async (page) => {
  await fill(page, { autosubmit: true });
  assert.equal(await page.evaluate(() => window.submitted), "enter");
});

await scenario("autosubmit stays off unless asked for, and never on page load", "autosubmit", async (page) => {
  await fill(page);
  assert.equal(await page.evaluate(() => window.submitted ?? false), false);
  await page.evaluate(() => (document.getElementById("p").value = ""));
  await fill(page, { autosubmit: true, onlyEmpty: true });
  assert.equal(await page.evaluate(() => window.submitted ?? false), false);
});

await scenario("card values take the shape their field asks for", "cardShapes", async (page) => {
  await formFill(page, { "cc-number": "4111 1111 1111 1111", "cc-exp": "12/30", "cc-exp-year": "2030" });
  const v = await values(page);
  assert.deepEqual([v.c, v.compact, v.long, v.year], ["4111111111111111", "1230", "12/2030", "30"]);
});

await scenario("a page details oversized string is truncated before it leaves the frame", "long", async (page) => {
  const details = await collect(page);
  assert.equal(details.fields[0].htmlName.length, 300);
  assert.equal(details.forms[0].text.length, 2000);
});

await scenario("a page's field values are not part of what it reports", "signup", async (page) => {
  await page.fill("#p", "typed-secret");
  assert.ok(!JSON.stringify(await collect(page)).includes("typed-secret"));
});

await browser.close();
server.close();
assert.deepEqual(errors, []);
console.log(`\n${pass} autofill scenarios passed`);
