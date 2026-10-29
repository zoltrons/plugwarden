import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Psl } from "../autofill/match.ts";
import { checkRpId } from "./fido2.ts";

// Needs dist/psl.json (node tools/fetch-psl.mjs).
const psl = new Psl(JSON.parse(readFileSync(new URL("../../dist/psl.json", import.meta.url), "utf8")) as string[]);
const ok = (rpId: string, origin: string) => checkRpId(rpId, origin, (d) => psl.isPublicSuffix(d));

test("passkey RP ID: the origin's host or a registrable parent of it", () => {
  ok("example.com", "https://example.com");
  ok("example.com", "https://login.example.com");
  ok("login.example.com", "https://login.example.com:8443");
  ok("localhost", "http://localhost:8099");
  ok("127.0.0.1", "http://127.0.0.1:8099");
});

test("passkey RP ID: refused for other sites, public suffixes and insecure origins", () => {
  assert.throws(() => ok("example.com", "https://evil.com"), /SecurityError/);
  assert.throws(() => ok("example.com", "https://example.com.evil.net"), /SecurityError/);
  assert.throws(() => ok("login.example.com", "https://example.com"), /SecurityError/); // child of the origin
  assert.throws(() => ok("com", "https://example.com"), /SecurityError/);
  assert.throws(() => ok("github.io", "https://alice.github.io"), /SecurityError/); // private-section suffix
  assert.throws(() => ok("example.com", "http://example.com"), /SecurityError/);
});
