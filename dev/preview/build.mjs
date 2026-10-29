#!/usr/bin/env node
// Builds the UI preview: the real popup/menu/bar code on top of a Chrome API stub.
//   node dev/preview/build.mjs        -> dev/preview/out
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const out = join(here, "out");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: {
    popup: "dev/preview/popup.entry.ts",
    menu: "dev/preview/menu.entry.ts",
    bar: "dev/preview/bar.entry.ts",
  },
  outdir: out,
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: "inline",
  logLevel: "warning",
});

copyFileSync(join(root, "src/ui/popup.css"), join(out, "popup.css"));

const shell = readFileSync(join(root, "src/ui/popup.html"), "utf8");
for (const [file, entry, body] of [
  ["index.html", "popup", "<body>"],
  ["menu.html", "menu", '<body class="frame">'],
  ["bar.html", "bar", '<body class="frame">'],
]) {
  writeFileSync(join(out, file), shell.replace("<body>", body).replace("popup.js", `${entry}.js`));
}
console.log(`preview built: ${out}`);
