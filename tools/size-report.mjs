#!/usr/bin/env node
// Prints raw / gzip -9 / brotli -q11 sizes and enforces tools/size-budget.json.
//   node tools/size-report.mjs [--check] <file>...
// Budget keys are paths relative to the repo root; values are max raw bytes.
import { readFileSync, existsSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter((a) => a !== "--check");
const budgetPath = resolve(root, "tools/size-budget.json");
const budget = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, "utf8")) : {};

const kb = (n) => (n / 1024).toFixed(1).padStart(8) + " KiB";
let failed = false;
console.log("file".padEnd(48), "raw".padStart(12), "gzip".padStart(12), "brotli".padStart(12));
for (const f of files) {
  const buf = readFileSync(f);
  const gz = gzipSync(buf, { level: 9 }).length;
  const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  const rel = relative(root, resolve(f)).replaceAll("\\", "/");
  const max = budget[rel];
  const over = max !== undefined && buf.length > max;
  failed ||= over;
  console.log(rel.padEnd(48), kb(buf.length), kb(gz), kb(br), max ? (over ? ` OVER ${max}` : ` <= ${max}`) : "");
}
if (check && failed) process.exit(1);
