#!/usr/bin/env node
// Builds the extension into dist/ext. Run tools/build-wasm.sh first (dist/wasm).
//   node tools/build.mjs [--watch] [--dev] [--e2e]
// --e2e compiles in the test-only hooks. Never use it for a release build.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/ext");
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const dev = args.includes("--dev") || watch;
const e2e = args.includes("--e2e");

const wasmDir = join(root, "dist/wasm");
if (!existsSync(join(wasmDir, "core_wasm_bg.wasm"))) {
  console.error("dist/wasm missing: run `npm run build:wasm` first");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function copyStatic() {
  const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));
  // Tests cannot click permission prompts: grant the optional permissions up front in e2e builds.
  if (e2e) manifest.permissions.push(...(manifest.optional_permissions ?? []));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  cpSync(join(root, "src/ui/popup.html"), join(out, "popup.html"));
  // Same UI in the side panel; the body class switches it to a fluid layout.
  writeFileSync(join(out, "sidepanel.html"), readFileSync(join(root, "src/ui/popup.html"), "utf8").replace("<body>", '<body class="panel">'));
  cpSync(join(root, "src/ui/popup.css"), join(out, "popup.css"));
  for (const f of ["menu.html", "bar.html"]) cpSync(join(root, "src/ui", f), join(out, f));
  cpSync(join(root, "src/offscreen/offscreen.html"), join(out, "offscreen.html"));
  cpSync(join(wasmDir, "core_wasm_bg.wasm"), join(out, "core_wasm_bg.wasm"));
  cpSync(join(wasmDir, "autofill_core_bg.wasm"), join(out, "autofill_core_bg.wasm"));
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
    menu: "src/ui/menu.ts",
    bar: "src/ui/bar.ts",
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
  define: { E2E: String(e2e) },
};

// Registered content scripts are classic scripts: bundle them as IIFEs.
const contentScripts = {
  ...options,
  entryPoints: {
    "passkey-page": "src/autofill/passkey-page.ts",
    "passkey-relay": "src/autofill/passkey-relay.ts",
    "sso-callback": "src/autofill/sso-callback.ts",
    page: "src/autofill/page.ts",
    content: "src/autofill/content.ts",
  },
  format: "iife",
};

copyStatic();
if (watch) {
  for (const o of [options, contentScripts]) await (await esbuild.context(o)).watch();
  console.log("watching…");
} else {
  await Promise.all([esbuild.build(options), esbuild.build(contentScripts)]);
  for (const f of ["background.js", "offscreen.js", "worker.js", "popup.js", "popup.css", "page.js", "content.js", "menu.js", "bar.js", "passkey-page.js", "passkey-relay.js", "core_wasm_bg.wasm", "autofill_core_bg.wasm"])
    console.log(f.padEnd(20), String(statSync(join(out, f)).size).padStart(8), "B");
}
