// Phase 0 bench: the service worker only creates the offscreen document and relays one message.
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    // Spike only. The production reason is decided in Phase 1 (see docs/PHASE0_REPORT.md).
    reasons: ["WORKERS"],
    justification: "Hosts the WebAssembly crypto core and the unlocked vault in memory.",
  });
}

self.bench = async (opts) => {
  const t0 = performance.now();
  await ensureOffscreen();
  const createMs = performance.now() - t0;
  const res = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "bench", opts });
  await chrome.offscreen.closeDocument();
  return { createOffscreenMs: createMs, ...res };
};
