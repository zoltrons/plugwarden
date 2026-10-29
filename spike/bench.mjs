#!/usr/bin/env node
// Loads spike/ext into Playwright's Chromium and runs the offscreen bench.
//   node spike/bench.mjs <wasm-dir> [official_bg.wasm]
// PLAYWRIGHT_CORE may point at a playwright-core module path (it is not a project dependency).
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [wasmDir, official] = process.argv.slice(2);
if (!wasmDir) throw new Error("usage: bench.mjs <wasm-dir> [official_bg.wasm]");

const pwPath = process.env.PLAYWRIGHT_CORE;
const { chromium } = await import(pwPath ? pathToFileURL(pwPath).href : "playwright-core");

const ext = mkdtempSync(join(tmpdir(), "pw-bench-ext-"));
const profile = mkdtempSync(join(tmpdir(), "pw-bench-profile-"));
cpSync(join(here, "ext"), ext, { recursive: true });
cpSync(join(wasmDir, "core_wasm.js"), join(ext, "core_wasm.js"));
cpSync(join(wasmDir, "core_wasm_bg.wasm"), join(ext, "core_wasm_bg.wasm"));
if (official) cpSync(resolve(official), join(ext, "official_bg.wasm"));

const ctx = await chromium.launchPersistentContext(profile, {
  // CHROME_PATH: a Chromium-based browser that still honours --load-extension (e.g. Helium).
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chromium" }),
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const result = await sw.evaluate((opts) => self.bench(opts), { runs: Number(process.env.RUNS ?? 3) });
  result.browserVersion = ctx.browser()?.version() ?? null;
  console.log(JSON.stringify(result, null, 2));
} finally {
  await ctx.close();
  rmSync(ext, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
