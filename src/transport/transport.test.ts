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
});

test("normalizeServerUrl", () => {
  assert.equal(normalizeServerUrl(" vault.example.com/ "), "https://vault.example.com");
  assert.equal(normalizeServerUrl("http://localhost:8080/vw/"), "http://localhost:8080/vw");
  assert.throws(() => normalizeServerUrl("https://u:p@host"));
  assert.throws(() => normalizeServerUrl("ftp://host"));
});
