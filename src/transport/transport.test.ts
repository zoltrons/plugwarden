import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeServerUrl } from "../shared/url.ts";
import { parseTwoFactorChallenge } from "./auth.ts";
import { errorMessage } from "./http.ts";

test("errorMessage skips Vaultwarden's empty error_description", () => {
  const body = { error: "", error_description: "", ErrorModel: { Message: "Invalid TOTP code!" }, message: "Invalid TOTP code!" };
  assert.equal(errorMessage(body, 400), "Invalid TOTP code!");
  assert.equal(errorMessage({ error_description: "Username or password is incorrect" }, 400), "Username or password is incorrect");
  assert.equal(errorMessage(null, 502), "HTTP 502");
});

test("parseTwoFactorChallenge reads providers and email hint", () => {
  const body = { error: "invalid_grant", TwoFactorProviders: ["0", "1"], TwoFactorProviders2: { "0": null, "1": { Email: "a***@x.test" } } };
  assert.deepEqual(parseTwoFactorChallenge(body), { providers: [0, 1], emailHint: "a***@x.test" });
  assert.equal(parseTwoFactorChallenge({ error: "invalid_grant" }), undefined);
  // An empty or non-numeric list is a plain error (wrong password), not a 2FA challenge.
  assert.equal(parseTwoFactorChallenge({ error: "invalid_grant", TwoFactorProviders: [] }), undefined);
  assert.equal(parseTwoFactorChallenge({ error: "invalid_grant", TwoFactorProviders: ["x"] }), undefined);
});

test("normalizeServerUrl", () => {
  assert.equal(normalizeServerUrl(" vault.example.com/ "), "https://vault.example.com");
  assert.equal(normalizeServerUrl("http://localhost:8080/vw/"), "http://localhost:8080/vw");
  assert.equal(normalizeServerUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.throws(() => normalizeServerUrl("https://u:p@host"));
  assert.throws(() => normalizeServerUrl("ftp://host"));
  // Plain http would send the auth hash, tokens and vault in clear text.
  assert.throws(() => normalizeServerUrl("http://vault.example.com"));
  assert.throws(() => normalizeServerUrl("http://localhost.evil.test"));
});
