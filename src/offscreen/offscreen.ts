// Offscreen document: owns the crypto worker and relays requests from the service worker only.
import { type CoreResult, OFFSCREEN_TARGET, parseCoreRequest } from "../shared/messages.ts";

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (r: CoreResult) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("worker.js", import.meta.url), { type: "module", name: "plugwarden-core" });
  worker.onmessage = (ev: MessageEvent<{ id: number; result: CoreResult }>) => {
    pending.get(ev.data.id)?.(ev.data.result);
    pending.delete(ev.data.id);
  };
  worker.onerror = (ev) => {
    for (const reply of pending.values()) reply({ ok: false, error: `worker error: ${ev.message}` });
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

function callWorker(req: unknown): Promise<CoreResult> {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, req });
  });
}

const SW_URL = chrome.runtime.getURL("background.js");

chrome.runtime.onMessage.addListener((msg: unknown, sender, reply: (r: CoreResult) => void) => {
  if (sender.id !== chrome.runtime.id || sender.url !== SW_URL || sender.tab) return false;
  if ((msg as { target?: unknown } | null)?.target !== OFFSCREEN_TARGET) return false;
  let req;
  try {
    req = parseCoreRequest((msg as { req: unknown }).req);
  } catch (e) {
    reply({ ok: false, error: String(e) });
    return false;
  }
  if (req.op === "lock") {
    // Locking tears the worker down entirely; the WASM memory goes with it.
    worker?.terminate();
    worker = undefined;
    for (const r of pending.values()) r({ ok: false, error: "locked" });
    pending.clear();
    reply({ ok: true, value: true });
    return false;
  }
  if (req.op === "clearClipboard") {
    // Offscreen documents have no focus, so navigator.clipboard is unavailable; execCommand works.
    const onCopy = (e: ClipboardEvent) => {
      e.clipboardData?.setData("text/plain", "");
      e.preventDefault();
    };
    document.addEventListener("copy", onCopy, { once: true });
    reply({ ok: true, value: document.execCommand("copy") });
    return false;
  }
  if (req.op === "status" && !worker) {
    reply({ ok: true, value: { unlocked: false } });
    return false;
  }
  callWorker(req).then(reply);
  return true;
});
