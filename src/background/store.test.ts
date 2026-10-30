import assert from "node:assert/strict";
import { test } from "node:test";

const session: Record<string, unknown> = {};
const local: Record<string, unknown> = {};
const area = (data: Record<string, unknown>) => ({
  // Real storage calls are async, so overlapping read-then-write calls can interleave.
  get: async (key: string | null) => {
    await new Promise((r) => setTimeout(r));
    return key === null ? { ...data } : { [key]: data[key] };
  },
  set: async (values: Record<string, unknown>) => {
    await new Promise((r) => setTimeout(r));
    Object.assign(data, values);
  },
  remove: async (keys: string[]) => {
    for (const k of keys) delete data[k];
  },
});
(globalThis as { chrome?: unknown }).chrome = { storage: { session: area(session), local: area(local) } };

const { clearPendingSaves, getSettings, updateSession } = await import("./store.ts");

test("overlapping session writes keep every change", async () => {
  await updateSession({ unlocked: true });
  await Promise.all([updateSession({ unlocked: false }), updateSession({ accessToken: "t" })]);
  assert.deepEqual(session.session, { unlocked: false, accessToken: "t" });
});

test("a failed write does not block the next one", async () => {
  const set = (globalThis as any).chrome.storage.session.set;
  (globalThis as any).chrome.storage.session.set = async () => {
    throw new Error("quota");
  };
  await assert.rejects(updateSession({ accessToken: "lost" }));
  (globalThis as any).chrome.storage.session.set = set;
  assert.equal((await updateSession({ accessToken: "kept" })).accessToken, "kept");
});

test("clearPendingSaves removes only waiting logins", async () => {
  Object.assign(session, { "save:1": {}, "save:2": {}, "inline:1": {} });
  await clearPendingSaves();
  assert.deepEqual(Object.keys(session).sort(), ["inline:1", "session"]);
});

test("the removed 10 and 20 second clipboard delays become 30 seconds", async () => {
  for (const old of ["tenSeconds", "twentySeconds"]) {
    local.settings = { clearClipboardDelay: old };
    assert.equal((await getSettings()).clearClipboardDelay, "thirtySeconds");
  }
  local.settings = { clearClipboardDelay: "oneMinute" };
  assert.equal((await getSettings()).clearClipboardDelay, "oneMinute");
});
