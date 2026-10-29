#!/usr/bin/env node
// Downloads public_suffix_list.dat at the commit pinned in upstream.lock and writes
// dist/psl.json: ICANN + private rules, IDNs converted to punycode (Chrome reports ASCII hostnames).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = readFileSync(join(root, "upstream.lock"), "utf8");
const commit = lock.match(/\[publicsuffix\][^[]*?commit = "([0-9a-f]{40})"/)?.[1];
if (!commit) throw new Error("upstream.lock: [publicsuffix].commit missing");
const res = await fetch(`https://raw.githubusercontent.com/publicsuffix/list/${commit}/public_suffix_list.dat`);
if (!res.ok) throw new Error(`PSL download failed: ${res.status}`);
const rules = (await res.text())
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("//"))
  .map((r) => {
    const prefix = r.match(/^[!*]\.?/)?.[0] ?? "";
    return prefix + (domainToASCII(r.slice(prefix.length)) || r.slice(prefix.length));
  });
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/psl.json"), JSON.stringify(rules));
console.log(`psl @ ${commit.slice(0, 12)}: ${rules.length} rules -> dist/psl.json`);
