import assert from "node:assert/strict";
import { test } from "node:test";
import { passwordLevel } from "./strength.ts";

test("short and plain is weak, long and mixed is very strong", () => {
  assert.equal(passwordLevel("password"), 0);
  assert.equal(passwordLevel("Tr0ub4dor&3"), 2);
  assert.equal(passwordLevel("correct-Horse-battery-9-staple"), 3);
  assert.equal(passwordLevel(""), 0);
});
