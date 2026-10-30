// Boundary validation: anything a page, a server or a file controls is shape- and size-checked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrameRequest, parsePasskeyCall, parsePageRequest, parseRequest } from "./messages.ts";

const throws = (fn: () => unknown, what: RegExp) => assert.throws(fn, what);

test("page requests: the inline nonce is required", () => {
  assert.deepEqual(parsePageRequest({ type: "inlineFocus", kind: "login", nonce: "n" }), { type: "inlineFocus", kind: "login", nonce: "n" });
  throws(() => parsePageRequest({ type: "inlineFocus", kind: "login" }), /nonce/);
  throws(() => parsePageRequest({ type: "inlineFocus", kind: "password", nonce: "n" }), /kind/);
});

test("page requests: a submitted login is size-capped", () => {
  const ok = parsePageRequest({ type: "loginSubmitted", username: "u", password: "p" });
  assert.deepEqual(ok, { type: "loginSubmitted", username: "u", password: "p" });
  throws(() => parsePageRequest({ type: "loginSubmitted", username: "u", password: "x".repeat(9000) }), /too long/);
  throws(() => parsePageRequest({ type: "loginSubmitted", username: "x".repeat(9000), password: "p" }), /too long/);
});

test("frame requests: inline actions need the nonce, bar actions need the save token", () => {
  assert.deepEqual(parseFrameRequest({ type: "inlineFill", id: "i", nonce: "n" }), { type: "inlineFill", id: "i", nonce: "n" });
  throws(() => parseFrameRequest({ type: "inlineFill", id: "i" }), /nonce/);
  throws(() => parseFrameRequest({ type: "inlineList" }), /nonce/);
  assert.deepEqual(parseFrameRequest({ type: "barAction", action: "save", token: "t" }), { type: "barAction", action: "save", token: "t" });
  throws(() => parseFrameRequest({ type: "barAction", action: "save" }), /token/);
  throws(() => parseFrameRequest({ type: "barInfo" }), /token/);
});

test("popup requests: unknown types and organization writes are refused", () => {
  throws(() => parseRequest({ type: "eval" }), /unknown message type/);
  throws(() => parseRequest({ type: "saveItem", item: { type: 1, name: "n", organizationId: "org" } }), /read-only/);
  throws(() => parseRequest({ type: "saveItem", item: { type: 9, name: "n" } }), /cannot be edited/);
  throws(() => parseRequest({ type: "saveItem", item: { type: 1, name: "  " } }), /required/);
  throws(() => parseRequest({ type: "setSettings", autoLockMinutes: 7 }), /not an allowed choice/);
});

test("popup requests: an import is size-capped", () => {
  assert.deepEqual(parseRequest({ type: "importVault", text: "{}" }), { type: "importVault", text: "{}" });
  throws(() => parseRequest({ type: "importVault", text: "x".repeat(17 * 1024 * 1024) }), /too long/);
});

test("passkey calls: page-supplied options are bounded", () => {
  const base = { kind: "get", conditional: false, options: { challenge: "c", allow: [] } };
  assert.deepEqual(parsePasskeyCall(base), { ...base, options: { ...base.options, rpId: undefined } });
  // A huge challenge or an endless allowCredentials list would otherwise be page-controlled work.
  throws(() => parsePasskeyCall({ ...base, options: { challenge: "x".repeat(2000), allow: [] } }), /too long/);
  throws(() => parsePasskeyCall({ ...base, options: { challenge: "c", allow: Array.from({ length: 65 }, (_, i) => `id${i}`) } }), /too many/);
  throws(() => parsePasskeyCall({ ...base, options: { challenge: "c", allow: [], rpId: "a".repeat(300) } }), /too long/);
  throws(
    () => parsePasskeyCall({ kind: "create", options: { rpName: "r", user: { id: "i", name: "n".repeat(2000), displayName: "d" }, challenge: "c", exclude: [], discoverable: true } }),
    /too long/,
  );
});

test("popup requests: alias generation names a known service and caps its settings", () => {
  assert.deepEqual(parseRequest({ type: "generateAlias", vendor: "fastmail" }), { type: "generateAlias", vendor: "fastmail" });
  throws(() => parseRequest({ type: "generateAlias", vendor: "sendgrid" }), /vendor/);
  const ok = { type: "setAliasSettings", settings: { vendor: "addyio", token: "t", baseUrl: "https://a.example", domain: "example.com", prefix: false } };
  assert.deepEqual(parseRequest(ok), ok);
  throws(() => parseRequest({ ...ok, settings: { ...ok.settings, token: "x".repeat(2000) } }), /too long/);
  throws(() => parseRequest({ ...ok, settings: { ...ok.settings, baseUrl: "x".repeat(600) } }), /too long/);
  throws(() => parseRequest({ type: "aliasSettings", vendor: "nope" }), /vendor/);
});
