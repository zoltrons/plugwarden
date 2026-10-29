// Popup. Talks only to the service worker through the typed message bus: no crypto, no network.
import { AUTO_LOCK_CHOICES, TWO_FACTOR } from "../shared/constants.ts";
import type { Request, State } from "../shared/messages.ts";
import { normalizeServerUrl, originPattern } from "../shared/url.ts";
import { type Child, h, send, t } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { type Ctx, generatorScreen, resetVault, toastEl, vaultScreen } from "./vault.ts";

// ---------- state ----------

interface Ui {
  busy: boolean;
  busyLabel?: string;
  error?: string;
  info?: string;
  tab: "vault" | "generator" | "settings";
  editServer: boolean;
  reveal: boolean;
  provider?: number;
}

const draft = { server: "", email: "", password: "", code: "", remember: false };
const ui: Ui = { busy: false, tab: "vault", editServer: false, reveal: false };
let state: State | undefined;

async function act(req: Request, busyLabel?: string): Promise<boolean> {
  Object.assign(ui, { busy: true, busyLabel, error: undefined, info: undefined });
  render();
  const res = await send<State>(req);
  ui.busy = false;
  ui.busyLabel = undefined;
  if (res.ok) state = res.data;
  else ui.error = res.error;
  render();
  return res.ok;
}

// ---------- building blocks ----------

const host = (url?: string) => (url ? new URL(url).host : "");

function field(opts: {
  icon: IconName;
  label: string;
  input: HTMLInputElement | HTMLSelectElement;
  trailing?: Child;
  extraClass?: string;
}) {
  const id = `f-${opts.label.replace(/\W+/g, "-").toLowerCase()}`;
  opts.input.id = id;
  return h(
    "div",
    { class: `field ${opts.extraClass ?? ""}` },
    icon(opts.icon),
    h("label", { for: id }, h("span", {}, opts.label), opts.input),
    opts.trailing,
  );
}

function bound(key: "server" | "email" | "password" | "code", props: Record<string, unknown>) {
  return h("input", {
    ...props,
    value: draft[key],
    disabled: ui.busy,
    oninput: (e: Event) => (draft[key] = (e.target as HTMLInputElement).value),
  });
}

function passwordField(autocomplete: string) {
  const input = bound("password", {
    type: ui.reveal ? "text" : "password",
    autocomplete,
    required: true,
    spellcheck: false,
    "data-autofocus": draft.email || autocomplete === "current-password" ? "1" : undefined,
  });
  const toggle = h(
    "button",
    {
      type: "button",
      class: "icon-btn",
      "aria-label": t(ui.reveal ? "hidePassword" : "showPassword"),
      onclick: () => {
        ui.reveal = !ui.reveal;
        render();
      },
    },
    icon(ui.reveal ? "eyeOff" : "eye"),
  );
  return field({ icon: "key", label: t("masterPassword"), input, trailing: toggle });
}

function errorBox(): Child {
  return ui.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, ui.error)) : null;
}

function busyBar(): Child {
  return ui.busy ? h("div", {}, h("div", { class: "progress" }), ui.busyLabel ? h("p", { class: "note" }, ui.busyLabel) : null) : null;
}

function submitButton(label: string) {
  return h("button", { type: "submit", class: "btn filled wide", disabled: ui.busy }, label);
}

function brand(title: string, subtitle?: Child) {
  return h("div", { class: "brand" }, h("div", { class: "logo" }, icon("shield")), h("h1", {}, title), subtitle ? h("p", {}, subtitle) : null);
}

// ---------- views ----------

function setupView(): HTMLElement {
  const onsubmit = (e: Event) => {
    e.preventDefault();
    let url: string;
    try {
      url = normalizeServerUrl(draft.server);
    } catch (err) {
      ui.error = (err as Error).message;
      render();
      return;
    }
    // Must run synchronously inside the user gesture.
    chrome.permissions.request({ origins: [originPattern(url)] }).then(
      async (granted) => {
        if (!granted) {
          ui.error = t("errPermissionDenied");
          render();
          return;
        }
        if (await act({ type: "setServer", url }, t("busyCheckingServer"))) ui.editServer = false;
      },
      (err: unknown) => {
        ui.error = String(err);
        render();
      },
    );
  };
  return h(
    "form",
    { class: "page center", onsubmit, novalidate: true },
    brand(t("appName"), t("setupSubtitle")),
    field({
      icon: "server",
      label: t("serverUrl"),
      input: bound("server", {
        type: "url",
        placeholder: "https://vault.example.com",
        autocomplete: "url",
        required: true,
        spellcheck: false,
        "data-autofocus": "1",
      }),
    }),
    errorBox(),
    busyBar(),
    h(
      "div",
      { class: "actions" },
      submitButton(t("continue")),
      state?.serverUrl
        ? h("button", { type: "button", class: "btn text", onclick: () => ((ui.editServer = false), (ui.error = undefined), render()) }, t("cancel"))
        : null,
    ),
    h("p", { class: "note" }, t("setupHint")),
  );
}

function serverChip() {
  return h(
    "button",
    {
      type: "button",
      class: "chip server-chip",
      disabled: ui.busy,
      "aria-label": t("changeServer"),
      onclick: () => {
        draft.server = state?.serverUrl ?? "";
        ui.editServer = true;
        ui.error = undefined;
        render();
      },
    },
    icon("server"),
    host(state?.serverUrl),
  );
}

function loginView(): HTMLElement {
  const onsubmit = (e: Event) => {
    e.preventDefault();
    const password = draft.password;
    draft.password = "";
    void act({ type: "login", email: draft.email, password }, t("busyLoggingIn"));
  };
  return h(
    "form",
    { class: "page center", onsubmit },
    brand(t("loginTitle")),
    serverChip(),
    field({
      icon: "mail",
      label: t("email"),
      input: bound("email", { type: "email", autocomplete: "username", required: true, spellcheck: false, "data-autofocus": draft.email ? undefined : "1" }),
    }),
    passwordField("current-password"),
    errorBox(),
    busyBar(),
    submitButton(t("logIn")),
  );
}

function twoFactorView(s: State): HTMLElement {
  const offered = s.twoFactor?.providers ?? [];
  const supported = [TWO_FACTOR.Authenticator, TWO_FACTOR.Email].filter((p) => offered.includes(p));
  if (ui.provider === undefined || !supported.includes(ui.provider as 0 | 1)) ui.provider = supported[0];
  const chip = (p: number, label: string, ic: IconName) =>
    h(
      "button",
      {
        type: "button",
        class: "chip",
        "aria-pressed": String(ui.provider === p),
        disabled: ui.busy,
        onclick: () => ((ui.provider = p), render()),
      },
      icon(ic),
      label,
    );
  const onsubmit = (e: Event) => {
    e.preventDefault();
    if (ui.provider === undefined) return;
    const token = draft.code;
    draft.code = "";
    void act({ type: "twoFactorSubmit", provider: ui.provider, token, remember: draft.remember }, t("busyVerifying"));
  };
  const remember = h("input", {
    type: "checkbox",
    checked: draft.remember,
    id: "remember",
    onchange: (e: Event) => (draft.remember = (e.target as HTMLInputElement).checked),
  });
  return h(
    "form",
    { class: "page", onsubmit },
    h(
      "div",
      { class: "top" },
      h("button", { type: "button", class: "icon-btn", "aria-label": t("back"), onclick: () => void act({ type: "twoFactorCancel" }) }, icon("back")),
      h("h1", {}, t("twoFactorTitle")),
    ),
    h("p", { class: "note" }, t("twoFactorSubtitle", s.email ?? "")),
    supported.length
      ? h(
          "div",
          { class: "chips", role: "group", "aria-label": t("twoFactorMethod") },
          offered.includes(TWO_FACTOR.Authenticator) ? chip(TWO_FACTOR.Authenticator, t("providerAuthenticator"), "phone") : null,
          offered.includes(TWO_FACTOR.Email) ? chip(TWO_FACTOR.Email, t("providerEmail"), "mail") : null,
        )
      : h("div", { class: "error" }, icon("error"), h("div", {}, t("twoFactorUnsupported"))),
    ui.provider === TWO_FACTOR.Email
      ? h(
          "button",
          {
            type: "button",
            class: "btn tonal wide",
            disabled: ui.busy,
            onclick: async () => {
              if (await act({ type: "twoFactorSendEmail" }, t("busySendingEmail"))) {
                ui.info = t("emailSent", s.twoFactor?.emailHint ?? s.email ?? "");
                render();
              }
            },
          },
          icon("mail"),
          t("sendEmailCode", s.twoFactor?.emailHint ?? ""),
        )
      : null,
    ui.info ? h("p", { class: "note", role: "status" }, ui.info) : null,
    supported.length
      ? field({
          icon: "lock",
          label: t("verificationCode"),
          extraClass: "code",
          input: bound("code", { inputMode: "numeric", autocomplete: "one-time-code", required: true, "data-autofocus": "1" }),
        })
      : null,
    supported.length
      ? h("label", { class: "check", for: "remember" }, h("div", { class: "body" }, t("rememberDevice")), h("span", { class: "switch" }, remember, h("span")))
      : null,
    errorBox(),
    busyBar(),
    supported.length ? submitButton(t("continue")) : null,
  );
}

function lockedView(s: State): HTMLElement {
  const onsubmit = (e: Event) => {
    e.preventDefault();
    const password = draft.password;
    draft.password = "";
    void act({ type: "unlock", password }, t("busyUnlocking"));
  };
  return h(
    "form",
    { class: "page center", onsubmit },
    h(
      "div",
      { class: "brand" },
      h("div", { class: "avatar", "aria-hidden": "true" }, (s.email ?? "?").slice(0, 1).toUpperCase()),
      h("h1", {}, t("lockedTitle")),
      h("p", {}, s.email ?? ""),
      h("p", {}, host(s.serverUrl)),
    ),
    passwordField("current-password"),
    errorBox(),
    busyBar(),
    h(
      "div",
      { class: "actions" },
      submitButton(t("unlock")),
      h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: () => void act({ type: "logout" }) }, t("logOut")),
    ),
  );
}

function navButton(tab: Ui["tab"], label: string, ic: IconName) {
  return h(
    "button",
    {
      type: "button",
      "aria-current": ui.tab === tab ? "page" : undefined,
      onclick: () => ((ui.tab = tab), render()),
    },
    h("span", { class: "pill" }, icon(ic)),
    label,
  );
}

function row(ic: IconName, title: string, sub?: string, trailing?: Child, extra: Record<string, unknown> = {}, tag: "div" | "button" = "div") {
  return h(tag, { class: "row", ...extra }, icon(ic), h("div", { class: "body" }, h("span", { class: "title" }, title), sub ? h("span", { class: "sub" }, sub) : null), trailing);
}

function autoLockLabel(m: number): string {
  if (m < 0) return t("autoLockRestart");
  return m < 60 ? t("minutes", String(m)) : t("hours", String(m / 60));
}

function settingsTab(s: State): HTMLElement {
  const select = h(
    "select",
    {
      "aria-label": t("autoLock"),
      onchange: (e: Event) => void act({ type: "setSettings", autoLockMinutes: Number((e.target as HTMLSelectElement).value) }),
    },
    ...AUTO_LOCK_CHOICES.map((m) => h("option", { value: String(m), selected: m === s.settings.autoLockMinutes }, autoLockLabel(m))),
  );
  const sysLock = h("input", {
    type: "checkbox",
    checked: s.settings.lockOnSystemLock,
    "aria-label": t("lockOnSystemLock"),
    onchange: (e: Event) => void act({ type: "setSettings", lockOnSystemLock: (e.target as HTMLInputElement).checked }),
  });
  return h(
    "div",
    { class: "page" },
    h("div", { class: "top" }, h("h1", {}, t("settings"))),
    h("h2", { class: "section-title" }, t("account")),
    h(
      "div",
      { class: "group" },
      row("user", s.email ?? "", t("loggedIn")),
      row("server", host(s.serverUrl), s.serverVersion ? t("serverVersion", s.serverVersion) : undefined),
    ),
    h("h2", { class: "section-title" }, t("security")),
    h(
      "div",
      { class: "group" },
      row("timer", t("autoLock"), undefined, select),
      row("lock", t("lockOnSystemLock"), undefined, h("span", { class: "switch" }, sysLock, h("span"))),
    ),
    h(
      "div",
      { class: "group" },
      row("lock", t("lockNow"), undefined, null, { type: "button", onclick: () => void act({ type: "lock" }) }, "button"),
      row("logout", t("logOut"), undefined, null, { type: "button", class: "row danger", onclick: () => void act({ type: "logout" }) }, "button"),
    ),
    errorBox(),
  );
}

function unlockedView(s: State): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(
    ui.tab === "settings" ? settingsTab(s) : ui.tab === "generator" ? generatorScreen(vaultCtx) : vaultScreen(vaultCtx),
    h(
      "nav",
      { class: "nav", "aria-label": t("navigation") },
      navButton("vault", t("vault"), "home"),
      navButton("generator", t("generator"), "dice"),
      navButton("settings", t("settings"), "settings"),
    ),
    toastEl() || "",
  );
  return frag;
}

// ---------- render ----------

const app = document.getElementById("app")!;
const vaultCtx: Ctx = { rerender: () => render(), lock: () => void act({ type: "lock" }) };
let firstRender = true;

function render(): void {
  if (!state) return;
  const s = state;
  if (s.phase !== "unlocked") {
    ui.tab = "vault"; // a new session always starts on the vault
    resetVault(); // and holds no decrypted data from the previous one
  }
  let view: Node;
  if (s.phase === "setup" || ui.editServer) view = setupView();
  else if (s.phase === "loggedOut") view = loginView();
  else if (s.phase === "twoFactor") view = twoFactorView(s);
  else if (s.phase === "locked") view = lockedView(s);
  else view = unlockedView(s);

  const focused = document.activeElement?.id;
  app.replaceChildren(view);
  const again = focused ? document.getElementById(focused) : null;
  ((again ?? app.querySelector("[data-autofocus]")) as HTMLElement | null)?.focus();
  if (firstRender) {
    firstRender = false;
    performance.mark("plugwarden:first-render");
  }
}

void send<State>({ type: "getState" }).then((res) => {
  if (res.ok) state = res.data;
  else {
    state = { phase: "setup", settings: { autoLockMinutes: 15, lockOnSystemLock: true } };
    ui.error = res.error;
  }
  draft.email = state.email ?? "";
  render();
});
