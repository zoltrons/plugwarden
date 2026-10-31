import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedKey, linkedValue } from "./linked-fields.ts";

test("linked ids read their property, and only in their own cipher type", () => {
  assert.equal(linkedValue(1, 101, { password: "p" }), "p");
  assert.equal(linkedValue(3, 305, { number: "4111" }), "4111");
  assert.equal(linkedValue(1, 305, { number: "4111" }), "");
  assert.equal(linkedValue(2, 100, { username: "u" }), "");
  assert.equal(linkedKey(4, "410"), undefined);
});

test("a linked full name joins what the identity has", () => {
  assert.equal(linkedValue(4, 418, { title: "Dr", firstName: "Ada", lastName: "L" }), "Dr Ada L");
  assert.equal(linkedValue(4, 418, {}), "");
});
