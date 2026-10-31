import assert from "node:assert/strict";
import { test } from "node:test";
import { LINKED, linkedIdFor, linkedKey, linkedValue } from "./linked-fields.ts";

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

test("a picked field links to what it holds, if the item has that", () => {
  assert.equal(linkedIdFor(1, "Username"), 100);
  assert.equal(linkedIdFor(1, "CurrentPassword"), 101);
  assert.equal(linkedIdFor(3, "CcNumber"), 305);
  assert.equal(linkedIdFor(4, "Email"), 410);
  assert.equal(linkedIdFor(1, "CcNumber"), undefined, "a login has no card number");
  assert.equal(linkedIdFor(2, "Username"), undefined, "a note has nothing to link to");
  assert.equal(linkedIdFor(1, "None"), undefined);
  assert.equal(linkedIdFor(1, undefined), undefined);
  for (const type of [1, 3, 4]) for (const a of ["Username", "Email", "CcNumber", "CcCsc", "Name", "Tel", "Country", "CountryName"]) {
    const id = linkedIdFor(type, a);
    if (id !== undefined) assert.ok(LINKED[type]!.some((l) => l.id === id));
  }
});
