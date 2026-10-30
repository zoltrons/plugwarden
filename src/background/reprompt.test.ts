// The re-prompt gate: default deny, per item, revocable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { grantReprompt, repromptGranted, repromptPending, repromptRequired, revokeReprompts } from "./reprompt.ts";

test("only CipherRepromptType.Password (1) is gated", () => {
  assert.equal(repromptRequired({ id: "a", reprompt: 1 }), true);
  assert.equal(repromptRequired({ id: "a", reprompt: 0 }), false);
  assert.equal(repromptRequired({ id: "a" }), false);
  assert.equal(repromptRequired({ id: "a", reprompt: "1" }), true); // the server sends numbers as JSON
  assert.equal(repromptRequired(undefined), false);
});

test("a flagged item is pending until it is granted, and grants are per item", () => {
  revokeReprompts();
  const flagged = { id: "cipher-a", reprompt: 1 };
  const other = { id: "cipher-b", reprompt: 1 };
  assert.equal(repromptPending(flagged), true, "default deny");
  grantReprompt("cipher-a");
  assert.equal(repromptGranted("cipher-a"), true);
  assert.equal(repromptPending(flagged), false);
  assert.equal(repromptPending(other), true, "a grant must not leak to another item");
  revokeReprompts();
  assert.equal(repromptPending(flagged), true, "locking revokes");
});

test("an unflagged item is never pending", () => {
  revokeReprompts();
  assert.equal(repromptPending({ id: "cipher-a", reprompt: 0 }), false);
  assert.equal(repromptPending({ id: "cipher-a" }), false);
});
