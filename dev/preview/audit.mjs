#!/usr/bin/env node
// Measures the rendered preview and reports geometry that is off the design grid:
// page inset 12, card radius 8, row height 48, one text column per screen, tab bar ~52.
//   node dev/preview/audit.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { webkit } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
  const file = join(out, path === "/" ? "index.html" : path);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

function webkitPath() {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const build = readdirSync(cache).filter((d) => d.startsWith("webkit-")).sort().at(-1);
  const run = build ? join(cache, build, "pw_run.sh") : undefined;
  return run && existsSync(run) ? run : undefined;
}

const browser = await webkit.launch({ executablePath: webkitPath() });
const page = await browser.newPage({ viewport: { width: 380, height: 600 } });

/** Runs in the page: returns the geometry of one screen. */
function measure() {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), r: +r.right.toFixed(1) };
  };
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const pageEl = q(".page");
  const rows = qa(".row").filter((r) => !r.closest(".nav") && !r.classList.contains("skeleton"));
  const cols = [...new Set(rows.map((r) => rect(r.querySelector(".body") ?? r).x))].sort((a, b) => a - b);
  const iconCols = [...new Set(rows.map((r) => (r.querySelector(":scope > svg.i") ? rect(r.querySelector(":scope > svg.i")).x : null)).filter((v) => v !== null))].sort((a, b) => a - b);
  const groups = qa(".group").map(rect);
  const switches = qa(".switch").map(rect);
  const titles = qa(".section-title, .letter").map((e) => ({ text: e.textContent.trim().slice(0, 12), ...rect(e) }));
  const nav = q(".nav");
  return {
    viewport: { w: innerWidth, h: innerHeight, scrollH: document.documentElement.scrollHeight },
    page: pageEl ? { padding: getComputedStyle(pageEl).padding, ...rect(pageEl) } : null,
    header: q(".top") ? rect(q(".top")) : null,
    groups,
    rows: rows.length,
    rowHeights: [...new Set(rows.map((r) => rect(r).h))].sort((a, b) => a - b),
    textColumns: cols,
    iconColumns: iconCols,
    titles,
    switches: switches.map((s) => ({ x: s.x, r: s.r })),
    nav: nav ? rect(nav) : null,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

const scenes = {
  list: async () => page.getByRole("searchbox").waitFor(),
  item: async () => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("listitem").filter({ hasText: "GitHub" }).click();
    await page.getByRole("heading", { name: "GitHub" }).waitFor();
  },
  editor: async () => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("listitem").filter({ hasText: "GitHub" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
  },
  settings: async () => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  },
  generator: async () => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Generator" }).click();
  },
};

for (const [name, run] of Object.entries(scenes)) {
  await page.goto(`${base}/?scene=${name}`);
  await page.waitForTimeout(250);
  await run();
  await page.waitForTimeout(150);
  const m = await page.evaluate(measure);
  console.log(`\n## ${name}`);
  console.log(JSON.stringify(m, null, 1));
}

await browser.close();
server.close();
