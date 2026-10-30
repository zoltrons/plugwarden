import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesQuery, parseQuery, type Searchable } from "./search.ts";

const item = (over: Partial<Searchable> = {}): Searchable => ({ name: "GitHub", sub: "ada@example.com", uris: ["https://github.com/login"], folder: "Work", type: ["login"], flags: ["favorite"], ...over });
const find = (q: string, i = item()) => matchesQuery(parseQuery(q), i);

test("plain words must all match; quotes keep a phrase together", () => {
  assert.equal(find("github ada"), true);
  assert.equal(find("github nope"), false);
  assert.equal(find('"ada@example"'), true);
  assert.equal(find('"git hub"'), false);
  assert.equal(find(""), true);
});

test("qualifiers look at one field", () => {
  assert.equal(find("title:git"), true);
  assert.equal(find("username:git"), false);
  assert.equal(find("domain:github.com"), true);
  assert.equal(find("domain:login"), false); // the path is not the host
  assert.equal(find("email:example"), true);
  assert.equal(find("folder:work"), true);
  assert.equal(find("type:log"), true);
  assert.equal(find("is:favorite"), true);
  assert.equal(find("is:weak"), false);
});

test("a leading dash excludes", () => {
  assert.equal(find("github -work"), true); // 'work' is not in the name, username or url
  assert.equal(find("github -ada"), false);
  assert.equal(find("-title:hub"), false);
});

test("unknown prefixes stay plain text", () => {
  assert.deepEqual(parseQuery("https://github"), [{ not: false, value: "https://github" }]);
  assert.equal(find("https://github"), true);
});
