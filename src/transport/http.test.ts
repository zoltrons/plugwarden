// The transport must not let a broken or hostile server exhaust the worker's memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, MAX_RESPONSE_BYTES, readBytes } from "./http.ts";

const stream = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    }),
    { headers },
  );

test("readBytes reads a small body", async () => {
  const bytes = await readBytes(stream([new TextEncoder().encode("hello "), new TextEncoder().encode("world")]));
  assert.equal(new TextDecoder().decode(bytes), "hello world");
});

test("readBytes refuses a body over the cap", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const many = Array.from({ length: 4 }, () => chunk);
  await assert.rejects(readBytes(stream(many), 2 * 1024 * 1024), (e: unknown) => e instanceof ApiError && /too large/.test(e.message));
});

test("readBytes refuses a declared oversize body without reading it", async () => {
  await assert.rejects(
    readBytes(stream([new Uint8Array(1)], { "content-length": String(MAX_RESPONSE_BYTES + 1) })),
    (e: unknown) => e instanceof ApiError && /too large/.test(e.message),
  );
});

test("readBytes handles an empty body", async () => {
  assert.equal((await readBytes(new Response(null))).byteLength, 0);
});
