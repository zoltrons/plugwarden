import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MATCH, Psl, uriMatches } from "./match.ts";

// Needs dist/psl.json (node tools/fetch-psl.mjs).
const psl = new Psl(JSON.parse(readFileSync(new URL("../../dist/psl.json", import.meta.url), "utf8")) as string[]);
const page = (u: string) => new URL(u);

test("baseDomain follows the Public Suffix List", () => {
  assert.equal(psl.baseDomain("login.example.com"), "example.com");
  assert.equal(psl.baseDomain("a.b.example.co.uk"), "example.co.uk");
  assert.equal(psl.baseDomain("alice.github.io"), "alice.github.io"); // private section
  assert.equal(psl.baseDomain("www.ck"), "www.ck"); // exception rule
  assert.equal(psl.baseDomain("foo.bar.ck"), "foo.bar.ck"); // wildcard rule
  assert.equal(psl.baseDomain("192.168.1.10"), "192.168.1.10");
  assert.equal(psl.baseDomain("localhost"), "localhost");
  assert.equal(psl.baseDomain("co.uk"), "co.uk");
});

test("domain match (default)", () => {
  assert.ok(uriMatches("https://example.com", null, page("https://login.example.com/x"), psl));
  assert.ok(uriMatches("example.com", undefined, page("http://example.com"), psl));
  assert.ok(!uriMatches("https://alice.github.io", null, page("https://mallory.github.io"), psl));
  assert.ok(!uriMatches("https://example.com", null, page("https://example.com.evil.net"), psl));
  assert.ok(!uriMatches("https://example.com", null, page("chrome://settings"), psl));
});

test("host, startsWith, exact, regex, never", () => {
  assert.ok(uriMatches("https://a.example.com:8443", MATCH.Host, page("https://a.example.com:8443/p"), psl));
  assert.ok(!uriMatches("https://a.example.com", MATCH.Host, page("https://b.example.com"), psl));
  assert.ok(uriMatches("https://example.com/app", MATCH.StartsWith, page("https://example.com/app/login"), psl));
  assert.ok(!uriMatches("https://example.com/app", MATCH.StartsWith, page("https://example.com/other"), psl));
  assert.ok(!uriMatches("https://example.com", MATCH.StartsWith, page("https://example.com.evil.net/"), psl));
  assert.ok(!uriMatches("https://mybank.com", null, page("http://mybank.com"), psl));
  assert.ok(uriMatches("https://localhost", MATCH.Host, page("http://localhost"), psl));
  assert.ok(uriMatches("https://example.com/login", MATCH.Exact, page("https://example.com/login"), psl));
  assert.ok(uriMatches("^https://([a-z]+\\.)?example\\.com/", MATCH.RegularExpression, page("https://www.example.com/x"), psl));
  assert.ok(!uriMatches("([", MATCH.RegularExpression, page("https://example.com"), psl));
  assert.ok(!uriMatches("https://example.com", MATCH.Never, page("https://example.com"), psl));
});

test("a saved URI without a match strategy uses the account default", () => {
  const p = page("https://accounts.example.com/login");
  // Default = Host: subdomains are not included.
  assert.ok(!uriMatches("https://example.com", null, p, psl, MATCH.Host));
  assert.ok(uriMatches("https://accounts.example.com", null, p, psl, MATCH.Host));
  // Default = StartsWith / Exact apply to the whole address.
  assert.ok(uriMatches("https://accounts.example.com", null, p, psl, MATCH.StartsWith));
  assert.ok(!uriMatches("https://accounts.example.com", null, page("https://accounts.example.com/login/x"), psl, MATCH.Exact));
  // Default = Never disables autofill for those entries.
  assert.ok(!uriMatches("https://accounts.example.com", null, p, psl, MATCH.Never));
  // An explicit strategy on the URI still wins over the default.
  assert.ok(uriMatches("https://example.com", MATCH.Domain, p, psl, MATCH.Never));
});
