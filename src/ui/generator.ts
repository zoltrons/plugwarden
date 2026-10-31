// Generator tab: password / passphrase / PIN / username, forwarded email aliases, and the history screen.
// Own state (`gst`); the vault screens only reach it through `resetGenerator`, `startGeneratorPick` and `generatorScreen`.
import {
  ALIAS_INFO,
  ALIAS_VENDORS,
  type AliasField,
  type AliasSettings,
  type AliasVendor,
  defaultAliasSettings,
  missingAliasFields,
} from "../shared/alias.ts";
import type { HistoryEntry } from "../shared/messages.ts";
import { type Child, h, send, t, when, withChevron } from "./dom.ts";
import { icon } from "./icons.ts";
import { actionRow, colorize, copy, copyButton, type Ctx, iconButton, sectionTitle, startEdit, strength, strengthBar, topBar } from "./vault.ts";

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const GEN_DEFAULTS: Json = {
  type: "password", length: 20, lowercase: true, uppercase: true, numbers: true, special: true, avoidAmbiguous: false, minLowercase: 1, minUppercase: 1, minNumber: 1, minSpecial: 1,
  numWords: 5, wordSeparator: "-", capitalize: true, includeNumber: true, pinLength: 4,
  usernameType: "word", email: "", domain: "", aliasVendor: "simplelogin",
};
const GEN_KEY = "genOptions";
const WORDLIST_KEY = "genWordlist";

/** The generator's last options (a device preference, like the sort order). */
function savedGen(): Json {
  try {
    const v = JSON.parse(localStorage.getItem(GEN_KEY) ?? "null");
    return { ...GEN_DEFAULTS, ...(v && typeof v === "object" && !Array.isArray(v) ? v : {}) };
  } catch {
    return { ...GEN_DEFAULTS }; // no storage in framed pages, or damaged JSON
  }
}

function savedWordlist(): string[] {
  try {
    return (localStorage.getItem(WORDLIST_KEY) ?? "").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** One word per line; empty lines and lines starting with # ; - / are comments (Keyguard's format). */
function parseWordlist(text: string): string[] {
  const words = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim();
    if (w && w.length <= 24 && !/^[#;\-/]/.test(w)) words.add(w);
  }
  return [...words].slice(0, 100_000);
}

/** What the worker gets: the saved options, plus the custom list for a passphrase. */
function genOptions(): Json {
  const o: Json = { ...gst.gen };
  if (o.type === "pin") o.length = o.pinLength;
  if (o.type === "passphrase") {
    const words = savedWordlist();
    if (words.length >= 100) o.wordlist = words;
  }
  return o;
}


const gst = {
  gen: savedGen(),
  generated: "",
  /** Forwarded email alias settings for the service selected in the generator (kept by the worker). */
  alias: undefined as AliasSettings | undefined,
  /** Which service's settings are being read right now (a switch mid-flight must not land). */
  aliasLoadingFor: undefined as AliasVendor | undefined,
  /** An alias request is in flight: a double-click must not create two addresses. */
  aliasBusy: false,
  /** Ready-made password variants shown under the generator. */
  suggestions: [] as string[],
  /** Generator history screen, while open. */
  history: undefined as HistoryEntry[] | undefined,
  error: undefined as string | undefined,
};

export function resetGenerator(): void {
  Object.assign(gst, { gen: savedGen(), generated: "", suggestions: [], history: undefined, alias: undefined, aliasLoadingFor: undefined, aliasBusy: false, error: undefined });
}

/** The edit form's generator: which field it fills, and how the value gets back to the form. */
export interface GeneratorPick {
  field: "password" | "username";
  use(value: string): void;
  back(): void;
}

const PICK_TYPES = { password: ["password", "passphrase", "pin"], username: ["username", "alias"] };

/** Opens the generator on a type that fits the field, with a value made for it. */
export function startGeneratorPick(field: GeneratorPick["field"]): void {
  if (!PICK_TYPES[field].includes(str(gst.gen.type))) gst.gen.type = PICK_TYPES[field][0];
  Object.assign(gst, { generated: "", suggestions: [], error: undefined });
}

const errorBox = (): Child => (gst.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, gst.error)) : null);


async function regenerate(ctx: Ctx) {
  if (gst.gen.type === "alias") {
    // Any option change or chip click lands here. It must not call the forwarding service: that
    // creates a real alias in the user's account. Only the generate / refresh buttons do (generateAliasNow).
    gst.suggestions = [];
    gst.error = undefined;
    gst.generated = "";
    ctx.rerender();
    return;
  }
  const r = await send<string>({ type: "generate", options: genOptions() });
  gst.generated = r.ok ? r.data : "";
  gst.error = r.ok ? undefined : r.error;
  gst.suggestions = [];
  ctx.rerender();
  if (!r.ok || gst.gen.type !== "password") return;
  // Three ready-made variants next to the configured one: a short site-friendly one and two long ones.
  const variants = [{ length: 16, special: false }, { length: 24 }, { length: 32 }];
  const all = await Promise.all(variants.map((v) => send<string>({ type: "generate", options: { ...genOptions(), ...v } })));
  if (gst.gen.type !== "password") return;
  gst.suggestions = all.flatMap((x) => (x.ok ? [x.data] : []));
  ctx.rerender();
}

/**
 * One alias request at a time. The answer is dropped when the user has switched service meanwhile:
 * an address from the previous service must not be shown (or saved into a login) as the new one.
 */
async function generateAliasNow(ctx: Ctx) {
  const alias = gst.alias;
  if (!alias || gst.aliasBusy || missingAliasFields(alias).length) return;
  gst.aliasBusy = true;
  try {
    const r = await send<string>({ type: "generateAlias", vendor: alias.vendor });
    if (gst.alias?.vendor !== alias.vendor) return;
    gst.generated = r.ok ? r.data : "";
    gst.error = r.ok ? undefined : r.error;
  } finally {
    gst.aliasBusy = false;
    ctx.rerender();
  }
}

/** Loads the selected service's settings from the worker once per generator visit. */
async function loadAlias(ctx: Ctx, vendor: AliasVendor) {
  gst.aliasLoadingFor = vendor;
  const r = await send<AliasSettings>({ type: "aliasSettings", vendor });
  if (gst.aliasLoadingFor !== vendor) return; // another service was selected meanwhile
  gst.aliasLoadingFor = undefined;
  if (str(gst.gen.aliasVendor) !== vendor) return;
  // Even a failed read leaves a value, so the screen does not request it again on every render.
  gst.alias = r.ok ? r.data : defaultAliasSettings(vendor);
  if (!r.ok) gst.error = r.error;
  ctx.rerender();
}

async function importWordlist(ctx: Ctx, file: File | undefined) {
  if (!file) return;
  const words = parseWordlist(await file.slice(0, 2 * 1024 * 1024).text());
  if (words.length < 100) return ((gst.error = t("wordlistTooShort")), ctx.rerender());
  try {
    localStorage.setItem(WORDLIST_KEY, words.join("\n"));
  } catch {
    return ((gst.error = t("wordlistNotSaved")), ctx.rerender());
  }
  gst.error = undefined;
  void regenerate(ctx);
}

async function openHistory(ctx: Ctx) {
  const r = await send<HistoryEntry[]>({ type: "generatorHistory" });
  if (r.ok) gst.history = r.data;
  else gst.error = r.error;
  ctx.rerender();
}

function historyScreen(ctx: Ctx, list: HistoryEntry[]): HTMLElement {
  const close = () => ((gst.history = undefined), ctx.rerender());
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), close), h("h1", { class: "grow" }, t("generatorHistory"))),
    list.length
      ? h(
          "div",
          { class: "group", role: "list" },
          ...list.map((e) =>
            h(
              "div",
              { class: "row", role: "listitem" },
              h("div", { class: "body" }, h("span", { class: "title mono" }, e.value), h("span", { class: "sub" }, when(e.date))),
              iconButton("copy", t("copyField", e.value), () => void copy(ctx, e.value)),
            ),
          ),
        )
      : h("div", { class: "empty" }, icon("timer"), h("strong", {}, t("generatorHistoryEmpty"))),
    list.length
      ? h(
          "button",
          {
            type: "button",
            class: "btn text",
            onclick: async () => ((await send({ type: "generatorHistoryClear" })).ok ? ((gst.history = []), ctx.rerender()) : undefined),
          },
          t("clear"),
        )
      : null,
    errorBox(),
  );
}

export function generatorScreen(ctx: Ctx, pick?: GeneratorPick): HTMLElement {
  if (gst.history) return historyScreen(ctx, gst.history);
  if (gst.gen.type !== "alias" && !gst.generated && !gst.error) void regenerate(ctx);
  const g = gst.gen;
  const set = (k: string, v: unknown) => {
    g[k] = v;
    try {
      localStorage.setItem(GEN_KEY, JSON.stringify(g));
    } catch {
      /* no storage */
    }
    void regenerate(ctx);
  };
  const toggle = (k: string, label: string) =>
    h(
      "label",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      h("span", { class: "switch" }, h("input", { type: "checkbox", checked: g[k] === true, onchange: (e: Event) => set(k, (e.target as HTMLInputElement).checked) }), h("span")),
    );
  const slider = (k: string, label: string, min: number, max: number, suffix = "") => {
    const badge = h("span", { class: "value-badge" }, `${String(g[k])}${suffix}`);
    const input = h("input", { type: "range", min, max, value: String(g[k]), "aria-label": label });
    // The filled part of the track is a CSS gradient driven by --fill.
    const paint = (v: number) => {
      const ratio = max === min ? 0 : (v - min) / (max - min);
      input.style.setProperty("--fill", `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`);
    };
    paint(Number(g[k]));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      badge.textContent = `${v}${suffix}`;
      paint(v);
    });
    input.addEventListener("change", () => set(k, Number(input.value)));
    return h(
      "div",
      { class: "row slider-row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      input,
      badge,
    );
  };
  g.email ||= ctx.email() ?? "";
  const chip = (type: string, label: string, key = "type") => h("button", { type: "button", class: "chip", "aria-pressed": String(g[key] === type), onclick: () => set(key, type) }, label);
  const text = (k: string, label: string, props: Record<string, unknown> = {}) =>
    h(
      "label",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      h("input", { ...props, value: str(g[k]), "aria-label": label, spellcheck: false, onchange: (e: Event) => set(k, (e.target as HTMLInputElement).value) }),
    );
  const custom = g.type === "passphrase" && savedWordlist().length >= 100;
  // The worker keeps the alias settings, encrypted (a token is a secret; no localStorage).
  const aliasVendor: AliasVendor = (ALIAS_VENDORS as readonly string[]).includes(str(g.aliasVendor)) ? (g.aliasVendor as AliasVendor) : "simplelogin";
  if (g.type === "alias" && gst.alias === undefined && gst.aliasLoadingFor !== aliasVendor) void loadAlias(ctx, aliasVendor);
  const aliasReady = !!gst.alias && gst.alias.vendor === aliasVendor && missingAliasFields(gst.alias).length === 0;
  const switchAlias = (v: AliasVendor) => {
    gst.alias = undefined;
    gst.generated = "";
    gst.error = undefined;
    set("aliasVendor", v);
  };
  let options: HTMLElement;
  if (g.type === "password")
    options = h(
      "div",
      { class: "group" },
      slider("length", t("length"), 5, 128),
      toggle("uppercase", "A–Z"),
      g.uppercase === true ? slider("minUppercase", t("minUppercase"), 0, 9) : null,
      toggle("lowercase", "a–z"),
      g.lowercase === true ? slider("minLowercase", t("minLowercase"), 0, 9) : null,
      toggle("numbers", "0–9"),
      toggle("special", "!@#$%^&*"),
      toggle("avoidAmbiguous", t("avoidAmbiguous")),
      g.numbers === true ? slider("minNumber", t("minDigits"), 0, 9) : null,
      g.special === true ? slider("minSpecial", t("minSymbols"), 0, 9) : null,
    );
  else if (g.type === "passphrase")
    options = h(
      "div",
      { class: "group" },
      slider("numWords", t("words"), 3, 20),
      text("wordSeparator", t("separator"), { class: "small-input", maxLength: 3 }),
      toggle("capitalize", t("capitalize")),
      toggle("includeNumber", t("includeNumber")),
      h(
        "div",
        { class: "row" },
        h("div", { class: "body" }, h("span", { class: "title" }, t("wordlist")), h("span", { class: "sub" }, custom ? t("wordlistCustom", String(savedWordlist().length)) : t("wordlistDefault"))),
        custom
          ? iconButton("close", t("wordlistReset"), () => {
              try {
                localStorage.removeItem(WORDLIST_KEY);
              } catch {
                /* no storage */
              }
              void regenerate(ctx);
            })
          : null,
        h("label", { class: "btn text small" }, t("wordlistImport"), h("input", { type: "file", class: "sr-only", accept: ".txt,.wordlist,text/plain", onchange: (e: Event) => void importWordlist(ctx, (e.target as HTMLInputElement).files?.[0]) })),
      ),
    );
  else if (g.type === "pin") options = h("div", { class: "group" }, slider("pinLength", t("length"), 3, 12));
  else if (g.type === "alias") {
    const info = ALIAS_INFO[aliasVendor];
    const saved = gst.alias;
    // `typing`: saved as it is typed, since closing the popup fires no change event and would lose a
    // pasted key. A re-render would take the focus, so that and any error wait for the change event.
    const save = (patch: Partial<AliasSettings>, typing = false) => {
      if (!saved) return;
      // gst.alias, not `saved`: a field typed into before the last re-render must not undo another.
      const next = { ...(gst.alias ?? saved), ...patch, vendor: aliasVendor };
      gst.alias = next;
      // The address on screen was made with the old settings, and making a new one is the user's
      // click, not a side effect of typing a key.
      gst.generated = "";
      gst.error = undefined;
      void (async () => {
        const r = await send({ type: "setAliasSettings", settings: next });
        if (typing) return;
        if (!r.ok) gst.error = r.error;
        ctx.rerender();
      })();
    };
    const input = (field: AliasField, label: string, hint: string, props: Record<string, unknown>) =>
      h(
        "label",
        { class: "row" },
        h("div", { class: "body" }, h("span", { class: "title" }, label), h("span", { class: "sub wrap" }, hint)),
        h("input", {
          ...props,
          value: saved ? str(saved[field]) : "",
          disabled: !saved, // edits before the settings arrive would be dropped
          "aria-label": label,
          spellcheck: false,
          autocomplete: "off",
          oninput: (e: Event) => save({ [field]: (e.target as HTMLInputElement).value } as Partial<AliasSettings>, true),
          onchange: (e: Event) => save({ [field]: (e.target as HTMLInputElement).value } as Partial<AliasSettings>),
        }),
      );
    options = h(
      "div",
      {},
      h(
        "div",
        { class: "group" },
        h(
          "div",
          { class: "row" },
          h("div", { class: "body" }, h("span", { class: "title" }, t("aliasService")), h("span", { class: "sub wrap" }, t("aliasServiceHint"))),
          withChevron(
            h(
              "select",
              { "aria-label": t("aliasService"), onchange: (e: Event) => switchAlias((e.target as HTMLSelectElement).value as AliasVendor) },
              ...ALIAS_VENDORS.map((v) => h("option", { value: v, selected: v === aliasVendor }, ALIAS_INFO[v].name)),
            ),
          ),
        ),
        input("token", t("aliasApiKey"), t("aliasApiKeyHint"), { type: "password" }),
        info.fields.includes("domain") ? input("domain", t("aliasDomain"), t("aliasDomainHint"), { type: "text", placeholder: "example.com" }) : null,
        info.selfHost ? input("baseUrl", t("aliasBaseUrl"), t("aliasBaseUrlHint"), { type: "text", placeholder: info.baseUrl }) : null,
        info.fields.includes("prefix")
          ? h(
              "label",
              { class: "row" },
              h("div", { class: "body" }, h("span", { class: "title" }, t("aliasWebsitePrefix")), h("span", { class: "sub wrap" }, t("aliasWebsitePrefixHint"))),
              h("span", { class: "switch" }, h("input", { type: "checkbox", checked: saved?.prefix === true, disabled: !saved, "aria-label": t("aliasWebsitePrefix"), onchange: (e: Event) => save({ prefix: (e.target as HTMLInputElement).checked }) }), h("span")),
            )
          : null,
      ),
      info.help
        ? h("button", { type: "button", class: "btn text small", onclick: () => void chrome.tabs.create({ url: info.help! }) }, t("aliasGetToken", info.name))
        : null,
    );
  } else
    options = h(
      "div",
      {},
      h("div", { class: "chips", role: "group", "aria-label": t("usernameType") }, chip("word", t("usernameWord"), "usernameType"), chip("plus", t("usernamePlus"), "usernameType"), chip("catchall", t("usernameCatchAll"), "usernameType"), chip("subdomain", t("usernameSubdomain"), "usernameType")),
      h(
        "div",
        { class: "group" },
        ...(g.usernameType === "plus" || g.usernameType === "subdomain"
          ? [text("email", t("email"), { type: "email" })]
          : g.usernameType === "catchall"
            ? [text("domain", t("domain"), { placeholder: "example.com" })]
            : [toggle("capitalize", t("capitalize")), toggle("includeNumber", t("includeNumber"))]),
      ),
    );
  return h(
    "div",
    { class: "page" },
    topBar(pick ? iconButton("back", t("back"), pick.back) : null, h("h1", { class: "grow" }, t("generator")), iconButton("timer", t("generatorHistory"), () => void openHistory(ctx))),
    h(
      "div",
      { class: "chips", role: "group", "aria-label": t("generator") },
      ...[
        chip("password", t("typePassword")),
        chip("passphrase", t("typePassphrase")),
        chip("pin", t("typePin")),
        chip("username", t("username")),
        chip("alias", t("forwardedEmailShort")),
      ].filter((_, i) => !pick || (pick.field === "password" ? i < 3 : i >= 3)),
    ),
    g.type === "alias" && !gst.generated ? null : h(
      "div",
      { class: "generated" },
      h(
        "div",
        { class: "generated-row" },
        h(
          "output",
          { class: "mono", "aria-live": "polite", "aria-label": t("generatedValue") },
          ...(gst.generated ? colorize(gst.generated) : ["…"]),
        ),
        h(
          "div",
          { class: "trailing" },
          iconButton("refresh", t("regenerate"), () => void (g.type === "alias" ? generateAliasNow(ctx) : regenerate(ctx))),
          iconButton(
            "copy",
            t("copyField", t("generatedValue")),
            () => {
              void copy(ctx, gst.generated);
              void send({ type: "generatorHistoryAdd", value: gst.generated });
            },
            { disabled: !gst.generated },
          ),
        ),
      ),
      h("div", { class: "generated-foot" }, gst.generated && g.type !== "alias" ? strengthBar(gst.generated) : null, gst.generated && g.type !== "alias" ? h("span", { class: "meter-label" }, strength(gst.generated).label) : null),
    ),
    options,
    g.type === "alias" && !gst.generated
      ? aliasReady
        ? h("button", { type: "button", class: "btn filled wide", onclick: () => void generateAliasNow(ctx) }, t("generateEmail"))
        : h("p", { class: "caption" }, t("aliasNotConfigured"))
      : null,
    gst.suggestions.length
      ? h(
          "div",
          {},
          sectionTitle(t("suggestions")),
          h("div", { class: "group", role: "list" }, ...gst.suggestions.map((v, i) => h("div", { class: "row", role: "listitem" }, h("div", { class: "body" }, h("span", { class: "title mono ellipsis" }, ...colorize(v)), h("span", { class: "sub" }, t("characters", String(v.length)))), copyButton(ctx, `sug.${i}`, v, t("copyField", t("generatedValue")))))),
        )
      : null,
    pick && gst.generated
      ? h("div", { class: "editor-footer" }, h("button", { type: "button", class: "btn filled wide", onclick: () => pick.use(gst.generated) }, icon("check"), t(pick.field === "password" ? "usePassword" : "useUsername")))
      : null,
    !pick && gst.generated
      ? actionRow("plus", t(g.type === "alias" ? "createLoginWithEmail" : g.type === "username" ? "createLoginWithUsername" : "createLoginWithPassword"), () => {
          ctx.goto("vault");
          startEdit(ctx, undefined, { data: { [g.type === "username" || g.type === "alias" ? "username" : "password"]: gst.generated } });
        })
      : null,
    errorBox(),
  );
}
