import assert from "node:assert/strict";
import { test } from "node:test";
import { isInsecureUri, mainPage, toHttps } from "./uri-tools.ts";

test("only http to a remote host is insecure, and upgrades keep path and query", () => {
  assert.equal(isInsecureUri("http://example.com/a?b=1"), true);
  assert.equal(isInsecureUri("https://example.com"), false);
  assert.equal(isInsecureUri("http://localhost:8080"), false);
  assert.equal(isInsecureUri("androidapp://com.example"), false);
  assert.equal(toHttps("http://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(toHttps("https://example.com"), undefined);
});

test("main page is offered only for deep links", () => {
  assert.equal(mainPage("https://example.com/login?next=/x"), "https://example.com/");
  assert.equal(mainPage("https://example.com/"), undefined);
  assert.equal(mainPage("https://example.com"), undefined);
  assert.equal(mainPage("not a url"), undefined);
});
