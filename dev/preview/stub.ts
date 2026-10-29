// Preview-only Chrome API stub so the popup/menu/bar UI can be rendered in a plain page
// (no extension host, no Vaultwarden). Used by `npm run preview`; never shipped.
import messages from "../../src/_locales/en/messages.json";
import type { MenuData, PageMatches, Request, Response, State, VaultItem, VaultList } from "../../src/shared/messages.ts";

type Json = Record<string, unknown>;

const scene = new URLSearchParams(location.search).get("scene") ?? "list";
const page = location.pathname;

function translate(key: string, subs: string[]): string {
  const entry = (messages as Record<string, { message: string }>)[key];
  if (!entry) return key;
  return entry.message.replace(/\$P(\d+)\$/g, (_, n: string) => subs[Number(n) - 1] ?? "");
}

const settings = {
  autoLockMinutes: 15,
  timeoutAction: "lock" as const,
  lockOnSystemLock: true,
  inlineMenu: true,
  savePrompt: true,
  neverSave: ["news.example"],
  defaultManager: false,
  favicons: true,
  autoCopyTotp: true,
  defaultUriMatch: 0,
  clearClipboardDelay: "fiveMinutes",
  autofillOnPageLoad: false,
  autofillOnPageLoadDefault: true,
  inlineMenuCards: true,
  inlineMenuIdentities: true,
  contextMenu: true,
  showCardsOnTab: true,
  showIdentitiesOnTab: true,
};

const state: State =
  scene === "locked"
    ? { phase: "locked", serverUrl: "https://vault.example.com", email: "ada@example.com", pinUnlock: true, settings }
    : scene === "login"
      ? { phase: "loggedOut", serverUrl: "https://vault.example.com", settings }
      : scene === "twofactor"
        ? {
            phase: "twoFactor",
            serverUrl: "https://vault.example.com",
            email: "ada@example.com",
            twoFactor: { providers: [0, 1] },
            settings,
          }
        : scene === "setup"
          ? { phase: "setup", settings }
          : { phase: "unlocked", serverUrl: "https://vault.example.com", serverVersion: "1.37.4", email: "ada@example.com", settings };

const item = (i: Partial<VaultItem> & { id: string; name: string }): VaultItem => ({
  type: 1,
  sub: "",
  uris: [],
  favorite: false,
  readOnly: false,
  hasTotp: false,
  revisionDate: Date.parse("2026-10-20T12:00:00Z"),
  creationDate: Date.parse("2026-01-04T12:00:00Z"),
  ...i,
});

const items: VaultItem[] = [
  item({ id: "1", name: "GitHub", sub: "octo", uris: ["https://github.com/login"], favorite: true, hasTotp: true }),
  item({ id: "2", name: "Google", sub: "ada@gmail.com", uris: ["https://accounts.google.com"], favorite: true }),
  item({ id: "3", name: "Work Amex", type: 3, sub: "Ada Lovelace" }),
  item({ id: "4", name: "Office Wi-Fi", type: 2, sub: "SSID: office" }),
  item({ id: "5", name: "PayPal", sub: "ada@example.com", uris: ["https://www.paypal.com"] }),
  item({ id: "6", name: "Amazon", sub: "ada@example.com", uris: ["https://www.amazon.com"] }),
  item({ id: "7", name: "Ada Lovelace", type: 4, sub: "Ada Lovelace" }),
  item({ id: "8", name: "Router", sub: "admin", uris: ["http://192.168.1.1"], folderId: "f1" }),
  item({ id: "9", name: "Banking", sub: "ada@example.com", uris: ["https://bank.example"], folderId: "f1" }),
  item({ id: "10", name: "Zendesk", sub: "ada@example.com", uris: ["https://zendesk.com"] }),
];

const vault: VaultList = {
  items,
  folders: [
    { id: "f1", name: "Work" },
    { id: "f2", name: "Personal" },
  ],
  trash: [],
  organizations: [{ id: "o1", name: "Team Alpha" }],
  collections: [{ id: "c1", name: "Engineering" }],
  syncedAt: Date.now(),
};

const matches: PageMatches = {
  host: "github.com",
  items: [items[0]!, items[9]!],
};

const github: Json = {
  id: "1",
  type: 1,
  name: "GitHub",
  favorite: true,
  folderId: "f1",
  revisionDate: "2026-10-20T12:00:00.000Z",
  notes: "Recovery codes are in the safe.\nBackup email: ada@example.com",
  login: {
    username: "octo",
    password: "gh-secret-1",
    totp: "JBSWY3DPEHPK3PXP",
    passwordRevisionDate: "2026-08-14T09:30:00.000Z",
    uris: [
      { uri: "https://github.com/login", match: null },
      { uri: "https://gist.github.com", match: null },
    ],
  },
  fields: [
    { name: "Recovery PIN", value: "4321", type: 1, linkedId: null },
    { name: "Team", value: "Platform", type: 0, linkedId: null },
  ],
  passwordHistory: [{ password: "gh-secret-old", lastUsedDate: "2026-08-14T09:30:00.000Z" }],
  attachments: [{ id: "a1", fileName: "recovery-codes.txt", sizeName: "1.2 KB" }],
};

const menuData: MenuData = {
  host: "github.com",
  locked: false,
  items: [
    { id: "1", type: 1, name: "GitHub", sub: "octo", uris: ["https://github.com"] },
    { id: "2", type: 1, name: "Google", sub: "ada@gmail.com", uris: ["https://accounts.google.com"] },
    { id: "10", type: 1, name: "Zendesk", sub: "ada@example.com", uris: ["https://zendesk.com"] },
  ],
};

function respond(req: Request): Response<unknown> {
  switch (req.type) {
    case "getState":
      return { ok: true, data: state };
    case "vaultList":
      return { ok: true, data: vault };
    case "sync":
      return { ok: true, data: vault };
    case "pageMatches":
      return { ok: true, data: matches };
    case "getItem":
      return { ok: true, data: github };
    case "totp":
      return { ok: true, data: { code: "123456", period: 30, remaining: 21 } };
    case "generate":
      return { ok: true, data: "k7#Vm2qT!pR9zLd4Xw8b" };
    case "generatorHistory":
      return { ok: true, data: [{ date: Date.now() - 60_000, value: "k7#Vm2qT!pR9zLd4Xw8b" }] };
    case "sendList":
      return { ok: true, data: [] };
    case "inlineList":
      return { ok: true, data: menuData };
    case "barInfo":
      return { ok: true, data: { kind: "add", host: "github.com", username: "octo" } };
    default:
      return { ok: true, data: null };
  }
}

const chromeStub = {
  i18n: { getMessage: (key: string, subs?: string | string[]) => translate(key, typeof subs === "string" ? [subs] : (subs ?? [])) },
  runtime: {
    getManifest: () => ({ version: "0.2.0", manifest_version: 3, name: "Plugwarden" }),
    sendMessage: async (req: Request) => {
      if (page.includes("menu") && req.type === "inlineList") return { ok: true, data: menuData };
      if (page.includes("bar") && req.type === "barInfo") return { ok: true, data: { kind: "add", host: "github.com", username: "octo" } };
      return respond(req);
    },
  },
  windows: { getCurrent: async () => ({ id: 1, focused: true, state: "normal", type: "normal", alwaysOnTop: false, incognito: false, top: 0, left: 0, width: 380, height: 600 }) },
  sidePanel: { open: async () => undefined },
  permissions: { request: async () => true },
  tabs: { create: async () => ({}), getCurrent: async () => undefined },
};

(globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
