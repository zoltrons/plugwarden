#!/usr/bin/env node
// Builds the extension into dist/ext. Run tools/build-wasm.sh first (dist/wasm).
//   node tools/build.mjs [--watch] [--dev] [--e2e-host=http://localhost:8080]
// --e2e-host adds a *required* host permission for that origin so automated tests do not hit the
// runtime permission prompt. Never use it for a release build.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/ext");
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const dev = args.includes("--dev") || watch;
// Comma-separated origins, e.g. --e2e-host=http://localhost:8080,http://localhost:8099
const e2eHosts = args.find((a) => a.startsWith("--e2e-host="))?.split("=")[1]?.split(",");

const wasmDir = join(root, "dist/wasm");
if (!existsSync(join(wasmDir, "core_wasm_bg.wasm"))) {
  console.error("dist/wasm missing: run `npm run build:wasm` first");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function copyStatic() {
  const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));
  if (e2eHosts) manifest.host_permissions = e2eHosts.map((h) => `${new URL(h).origin}/*`);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  cpSync(join(root, "src/ui/popup.html"), join(out, "popup.html"));
  cpSync(join(root, "src/ui/popup.css"), join(out, "popup.css"));
  cpSync(join(root, "src/offscreen/offscreen.html"), join(out, "offscreen.html"));
  cpSync(join(wasmDir, "core_wasm_bg.wasm"), join(out, "core_wasm_bg.wasm"));
  if (!existsSync(join(root, "dist/psl.json"))) throw new Error("dist/psl.json missing: run `node tools/fetch-psl.mjs`");
  cpSync(join(root, "dist/psl.json"), join(out, "psl.json"));
  cpSync(join(root, "src/_locales"), join(out, "_locales"), { recursive: true });
}

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: "src/background/index.ts",
    offscreen: "src/offscreen/offscreen.ts",
    worker: "src/offscreen/worker.ts",
    popup: "src/ui/popup.ts",
  },
  outdir: out,
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  target: "chrome156",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
  define: { E2E: String(!!e2eHosts) },
};

copyStatic();
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching…");
} else {
  await esbuild.build(options);
  for (const f of ["background.js", "offscreen.js", "worker.js", "popup.js", "popup.css", "core_wasm_bg.wasm"])
    console.log(f.padEnd(20), String(statSync(join(out, f)).size).padStart(8), "B");
}
