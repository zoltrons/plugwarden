#!/usr/bin/env node
// Screenshots the preview in both themes with Playwright's WebKit.
//   node dev/preview/build.mjs && node dev/preview/shot.mjs [outDir]
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const shots = process.argv[2] ?? join(out, "shots");
mkdirSync(shots, { recursive: true });

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" };
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

// Use any installed WebKit build; the pinned Playwright revision may not be downloaded.
function webkitPath() {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const build = readdirSync(cache).filter((d) => d.startsWith("webkit-")).sort().at(-1);
  const run = build ? join(cache, build, "pw_run.sh") : undefined;
  return run && existsSync(run) ? run : undefined;
}

const browser = await webkit.launch({ executablePath: webkitPath() });
const errors = [];

async function open(path, { width = 380, height = 600 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on("console", (m) => {
    // Favicon requests to the fake server host fail in the preview; they are expected.
    if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(`${path}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${path}: ${e.message}`));
  await page.goto(base + path);
  await page.waitForTimeout(250);
  return page;
}

const scenes = {
  list: async (page) => page.getByRole("searchbox").waitFor(),
  item: async (page) => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("listitem").filter({ hasText: "GitHub" }).click();
    await page.getByRole("heading", { name: "GitHub" }).waitFor();
  },
  editor: async (page) => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("listitem").filter({ hasText: "GitHub" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
  },
  settings: async (page) => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  },
  generator: async (page) => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Generator" }).click();
  },
  alias: async (page) => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Generator" }).click();
    await page.getByRole("button", { name: "Alias", exact: true }).click();
  },
  send: async (page) => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Send" }).click();
  },
  sendFile: async (page) => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "New Send" }).click();
    await page.getByRole("button", { name: "File", exact: true }).click();
  },
  folders: async (page) => {
    await page.getByRole("searchbox").waitFor();
    await page.getByRole("button", { name: "Folders", exact: true }).click();
  },
  passkey: async (page) => page.getByRole("heading").first().waitFor(),
  locked: async () => {},
  login: async () => {},
  twofactor: async () => {},
  setup: async () => {},
};

for (const scheme of ["light", "dark"]) {
  for (const [name, run] of Object.entries(scenes)) {
    const page = await open(name === "passkey" ? "/?scene=passkey&passkey=demo" : `/?scene=${name}`);
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(120);
    await run(page);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shots, `${scheme}-${name}.png`) });
    await page.close();
  }
  for (const frame of ["menu", "bar"]) {
    const page = await open(`/${frame}.html`, { width: 320, height: 176 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shots, `${scheme}-${frame}.png`) });
    await page.close();
  }
  // The inline menu as it appears on a page: same iframe sizing/offset/shadow as the content script.
  const inline = await open("/inline.html", { width: 720, height: 470 });
  await inline.emulateMedia({ colorScheme: scheme });
  await inline.waitForTimeout(500);
  await inline.screenshot({ path: join(shots, `${scheme}-inline.png`) });
  await inline.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`shots: ${shots}`);
