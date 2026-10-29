#!/usr/bin/env node
// Read-only upstream diff report. For every entry in upstream-map.yaml, compares the pin in
// upstream.lock with upstream main (via `gh api .../compare`) and prints Markdown grouped by local
// module, flagging likely breaking changes. Never edits code.
//   node tools/sync-upstream.mjs > upstream-report.md
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// shortcut: line-based parsers for our own two flat files, not general TOML/YAML; switch to real parsers if the formats grow.
function readLock() {
  const lock = {};
  let section;
  for (const line of readFileSync(join(root, "upstream.lock"), "utf8").split(/\r?\n/)) {
    const s = line.replace(/#.*$/, "").trim();
    const head = s.match(/^\[(.+)\]$/);
    if (head) lock[(section = head[1])] = {};
    else if (section && s.includes("=")) {
      const [k, v] = s.split(/=(.*)/s).map((x) => x.trim());
      lock[section][k] = v.replace(/^"|"$/g, "");
    }
  }
  return lock;
}

function readMap() {
  const entries = [];
  for (const line of readFileSync(join(root, "upstream-map.yaml"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^(-\s+|\s+)(\w+):\s*(.*)$/);
    if (!m) continue;
    if (m[1].startsWith("-")) entries.push({});
    entries.at(-1)[m[2]] = m[3];
  }
  return entries;
}

const lock = readLock();
const pins = {
  "sdk-internal": { slug: "bitwarden/sdk-internal", base: lock["sdk-internal"].rev, head: "main" },
  clients: { slug: "bitwarden/clients", base: lock.clients.commit, head: "main" },
  vaultwarden: { slug: "dani-garcia/vaultwarden", base: lock.vaultwarden.version, head: "main" },
};

// shortcut: one compare page (GitHub caps it at 300 files), fine for weekly runs; paginate if a pin falls far behind.
// Patterns in added/removed lines that usually mean a protocol or format change.
const FLAGS = [
  [/\benum\b|=\s*\d+,\s*$/, "enum / numeric discriminant"],
  [/EncString|Cose|COSE|XChaCha|EncryptedString/, "key / EncString format"],
  [/\bKdf|Argon2|Pbkdf2|kdf_/i, "KDF"],
  [/#\[serde|pub struct|rename_all|alias\s*=/, "wire struct / serde shape"],
  [/required|missing field|Option</, "required vs optional field"],
  [/#\[(get|post|put|delete)\(/, "endpoint"],
  [/minimum_chrome_version|"permissions"|host_permissions/, "manifest"],
];

const compares = new Map();
function compare(repo) {
  if (!compares.has(repo)) {
    const { slug, base, head } = pins[repo];
    const json = execFileSync("gh", ["api", `repos/${slug}/compare/${base}...${head}`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    compares.set(repo, JSON.parse(json));
  }
  return compares.get(repo);
}

const out = [`# Upstream sync report`, ``, `Generated ${new Date().toISOString()} from \`upstream.lock\`.`, ``];
for (const repo of Object.keys(pins)) {
  const c = compare(repo);
  out.push(`- **${repo}** \`${pins[repo].base.slice(0, 12)}\`…main: ${c.ahead_by} commits ahead`);
}
const byLocal = new Map();
for (const e of readMap()) byLocal.set(e.local, [...(byLocal.get(e.local) ?? []), e]);

for (const [local, entries] of byLocal) {
  const sections = [];
  for (const e of entries) {
    const files = (compare(e.repo).files ?? []).filter((f) => f.filename.startsWith(e.path));
    if (!files.length) continue;
    sections.push(`### ${e.repo}: \`${e.path}\``, `_${e.sync}_`, ``);
    for (const f of files) {
      const changed = (f.patch ?? "").split("\n").filter((l) => /^[+-](?![+-])/.test(l));
      const flags = [...new Set(FLAGS.filter(([re]) => changed.some((l) => re.test(l))).map(([, n]) => n))];
      sections.push(`- \`${f.filename}\` ${f.status} +${f.additions}/-${f.deletions}${flags.length ? ` ⚠️ ${flags.join(", ")}` : ""}`);
    }
    sections.push(``);
  }
  out.push(``, `## ${local}`, ``, ...(sections.length ? sections : ["No upstream changes.", ""]));
}
console.log(out.join("\n"));
