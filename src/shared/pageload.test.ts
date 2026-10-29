import assert from "node:assert/strict";
import { test } from "node:test";
import type { VaultItem } from "./messages.ts";
import { pickPageLoadLogin } from "./pageload.ts";

const login = (id: string, name: string, autofillOnPageLoad?: boolean): VaultItem => ({
  id,
  type: 1,
  name,
  sub: "",
  uris: ["https://example.com"],
  favorite: false,
  readOnly: false,
  hasTotp: false,
  ...(autofillOnPageLoad === undefined ? {} : { autofillOnPageLoad }),
});

test("page load: the account default applies only to items that do not set it", () => {
  const items = [login("a", "Alpha"), login("b", "Bravo", false), login("c", "Charlie", true)];
  assert.equal(pickPageLoadLogin(items, true)?.id, "a"); // a inherits on, b opts out, c opts in
  assert.equal(pickPageLoadLogin(items, false)?.id, "c"); // only c opts in
  assert.equal(pickPageLoadLogin([login("b", "Bravo", false)], false), undefined);
});

test("page load: the login last used for the site wins, else the first by name", () => {
  const items = [login("a", "Zulu"), login("b", "Alpha")];
  assert.equal(pickPageLoadLogin(items, true)?.id, "b");
  assert.equal(pickPageLoadLogin(items, true, { a: 10, b: 20 })?.id, "b");
  assert.equal(pickPageLoadLogin(items, true, { a: 30, b: 20 })?.id, "a");
});

test("page load: non-logins and undecryptable items never fill", () => {
  const card = { ...login("c", "Card"), type: 3 };
  const broken = { ...login("d", "Broken"), failed: true } as VaultItem;
  assert.equal(pickPageLoadLogin([card, broken], true), undefined);
});
