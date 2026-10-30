import assert from "node:assert/strict";
import { test } from "node:test";
import { qrMatrix, reedSolomon } from "./qr.ts";

test("Reed-Solomon matches the published HELLO WORLD 1-M example", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("matrix has the right size, finder patterns and timing line", () => {
  const m = qrMatrix("https://example.com");
  assert.equal(m.length, 25); // 19 bytes need version 2
  for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]] as const) {
    assert.equal(m[y]![x], true);
    assert.equal(m[y + 3]![x + 3], true);
    assert.equal(m[y + 1]![x + 1], false);
  }
  for (let i = 8; i < m.length - 8; i++) assert.equal(m[6]![i], i % 2 === 0);
});

test("grows with the payload and refuses what does not fit", () => {
  assert.equal(qrMatrix("a".repeat(100)).length, 17 + 4 * 6);
  assert.equal(qrMatrix("a".repeat(213)).length, 17 + 4 * 10);
  assert.throws(() => qrMatrix("a".repeat(214)));
});
