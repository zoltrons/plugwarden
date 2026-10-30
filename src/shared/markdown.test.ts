import assert from "node:assert/strict";
import { test } from "node:test";
import { hasMarkup, parseInline } from "../shared/markdown.ts";

test("inline markup is split into tokens", () => {
  assert.deepEqual(parseInline("a **b** *c* `d` [e](https://x.y/z)"), [
    { kind: "text", text: "a " },
    { kind: "bold", text: "b" },
    { kind: "text", text: " " },
    { kind: "italic", text: "c" },
    { kind: "text", text: " " },
    { kind: "code", text: "d" },
    { kind: "text", text: " " },
    { kind: "link", text: "e", href: "https://x.y/z" },
  ]);
});

test("javascript: links and lone asterisks stay plain text", () => {
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ kind: "text", text: "[x](javascript:alert(1))" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ kind: "text", text: "2 * 3 * 4" }]);
});

test("plain notes do not offer formatting", () => {
  assert.equal(hasMarkup("code: a_b_c 2 * 3"), false);
  assert.equal(hasMarkup("- one\n- two"), true);
  assert.equal(hasMarkup("see **this**"), true);
});
