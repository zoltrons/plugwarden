import assert from "node:assert/strict";
import { test } from "node:test";
import { countInRange } from "./pwned.ts";

test("finds the suffix, ignores padding rows and case", () => {
  const body = "0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\n011053FD0102E94D6AE2F8B83D76FAF94F6:12";
  assert.equal(countInRange(body, "011053FD0102E94D6AE2F8B83D76FAF94F6"), 12);
  assert.equal(countInRange(body, "00D4F6E8FA6EECAD2A3AA415EEC418D38EC"), 0);
  assert.equal(countInRange(body, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"), 0);
});
