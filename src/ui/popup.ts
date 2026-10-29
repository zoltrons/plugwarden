// Popup. Talks only to the service worker through the typed message bus: no crypto, no network.
import { AUTO_LOCK_CHOICES, TWO_FACTOR } from "../shared/constants.ts";
import type { Request, State } from "../shared/messages.ts";
import { normalizeServerUrl, originPattern } from "../shared/url.ts";
import { applyTheme, type Child, h, inPanel, savedTheme, send, t, THEMES } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { passkeyRequestId, passkeyScreen } from "./passkey.ts";
import { resetSend, sendScreen } from "./send.ts";
import { type Ctx, generatorScreen, resetVault, toastEl, vaultScreen } from "./vault.ts";

// ---------- state ----------

interface Ui {
  busy: boolean;
  busyLabel?: string;
  error?: string;
  info?: string;
  tab: "vault" | "generator" | "send" | "settings";
  editServer: boolean;
  reveal: boolean;
  provider?: number;
  /** WebAuthn was cancelled or failed: wait for a click instead of prompting again on every render. */
  webauthnPaused?: boolean;
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
    h(
      "div",
      { class: "actions" },
      submitButton(t("logIn")),
      h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: () => void act({ type: "ssoStart" }, t("busyOpeningSso")) }, t("logInSso")),
    ),
    h("p", { class: "note" }, t("ssoHint")),
  );
}

// WebAuthn runs in the server's webauthn-connector.html (the credential is bound to the server's
// origin, which an extension page cannot claim). It reports back with postMessage "success|<json>".
let webauthnFrame: HTMLIFrameElement | undefined;
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

function webauthnBox(s: State): Child {
  if (ui.busy) return null;
  if (ui.webauthnPaused || !s.twoFactor?.webauthn || !s.serverUrl) {
    webauthnFrame = undefined;
    return h("button", { type: "button", class: "btn tonal wide", onclick: () => ((ui.webauthnPaused = false), (ui.error = undefined), render()) }, icon("key"), t("useSecurityKey"));
  }
  const options = JSON.parse(s.twoFactor.webauthn) as { extensions?: { appid?: string } };
  // The legacy U2F appid must be https; browsers reject the whole request otherwise (plain-http servers).
  if (!s.serverUrl.startsWith("https:")) delete options.extensions?.appid;
  const data = JSON.stringify({ data: JSON.stringify(options), headerText: "", btnText: t("useSecurityKey"), btnReturnText: "" });
  const params = new URLSearchParams({ data: b64(data), parent: location.href, v: "2" });
  webauthnFrame = h("iframe", {
    class: "webauthn",
    title: t("providerWebAuthn"),
    allow: "publickey-credentials-get *",
    src: `${s.serverUrl}/webauthn-connector.html?${params}`,
  });
  return h(
    "div",
    { class: "actions" },
    webauthnFrame,
    // The OS security-key dialog takes focus, which closes the action popup; a tab survives it.
    inPanel ? null : h("button", { type: "button", class: "btn text", onclick: () => void chrome.tabs.create({ url: location.href }) }, t("openInTab")),
  );
}

window.addEventListener("message", (ev: MessageEvent) => {
  if (!webauthnFrame || ev.source !== webauthnFrame.contentWindow || typeof ev.data !== "string") return;
  if (!state?.serverUrl || ev.origin !== new URL(state.serverUrl).origin) return;
  const [kind, ...rest] = ev.data.split("|");
  if (kind === "success") void submitWebAuthn(rest.join("|"));
  else if (kind === "error") {
    ui.webauthnPaused = true;
    ui.error = rest.join("|");
    render();
  }
});

async function submitWebAuthn(token: string) {
  webauthnFrame = undefined;
  if (await act({ type: "twoFactorSubmit", provider: TWO_FACTOR.WebAuthn, token, remember: draft.remember }, t("busyVerifying"))) return;
  // A failed attempt makes the server issue a new challenge; pick it up before the next try.
  const r = await send<State>({ type: "getState" });
  if (r.ok) state = r.data;
  ui.webauthnPaused = true;
  render();
}

function twoFactorView(s: State): HTMLElement {
  const offered = s.twoFactor?.providers ?? [];
  const supported: number[] = [TWO_FACTOR.Authenticator, TWO_FACTOR.Email, TWO_FACTOR.WebAuthn].filter(
    (p) => offered.includes(p) && (p !== TWO_FACTOR.WebAuthn || !!s.twoFactor?.webauthn),
  );
  if (ui.provider === undefined || !supported.includes(ui.provider)) ui.provider = supported[0];
  const typed = supported.length > 0 && ui.provider !== TWO_FACTOR.WebAuthn;
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
          supported.includes(TWO_FACTOR.WebAuthn) ? chip(TWO_FACTOR.WebAuthn, t("providerWebAuthn"), "key") : null,
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
    ui.provider === TWO_FACTOR.WebAuthn ? webauthnBox(s) : null,
    typed
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
    typed ? submitButton(t("continue")) : null,
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
  const passkeys = h("input", {
    type: "checkbox",
    checked: s.settings.passkeys,
    "aria-label": t("passkeys"),
    onchange: (e: Event) => {
      const box = e.target as HTMLInputElement;
      if (!box.checked) return void act({ type: "setPasskeys", enabled: false });
      // Site access is requested inside the click (user gesture); it is what lets the shim run on websites.
      chrome.permissions.request({ origins: ["https://*/*"] }).then(
        (granted) => (granted ? void act({ type: "setPasskeys", enabled: true }) : ((box.checked = false), (ui.error = t("errPermissionDenied")), render())),
        (err: unknown) => ((box.checked = false), (ui.error = String(err)), render()),
      );
    },
  });
  const toggle = (label: string, checked: boolean, onchange: (box: HTMLInputElement) => void) =>
    h("span", { class: "switch" }, h("input", { type: "checkbox", checked, "aria-label": label, onchange: (e: Event) => onchange(e.target as HTMLInputElement) }), h("span"));
  const defaultManager = (box: HTMLInputElement) => {
    if (!box.checked) return void act({ type: "setDefaultManager", enabled: false });
    // The optional "privacy" permission must be requested inside the click.
    chrome.permissions.request({ permissions: ["privacy"] }).then(
      (granted) => (granted ? void act({ type: "setDefaultManager", enabled: true }) : ((box.checked = false), (ui.error = t("errPermissionDenied")), render())),
      (err: unknown) => ((box.checked = false), (ui.error = String(err)), render()),
    );
  };
  return h(
    "div",
    { class: "page" },
    h("div", { class: "top" }, h("h1", {}, t("settings"))),
    h("h2", { class: "section-title" }, t("autofill")),
    h(
      "div",
      { class: "group" },
      row("home", t("inlineMenu"), t("inlineMenuHint"), toggle(t("inlineMenu"), s.settings.inlineMenu, (b) => void act({ type: "setSettings", inlineMenu: b.checked }))),
      row("plus", t("savePrompt"), t("savePromptHint"), toggle(t("savePrompt"), s.settings.savePrompt, (b) => void act({ type: "setSettings", savePrompt: b.checked }))),
      s.settings.neverSave.length
        ? row("globe", t("neverSaveSites", String(s.settings.neverSave.length)), s.settings.neverSave.join(", "), h("button", { type: "button", class: "btn text small", onclick: () => void act({ type: "setSettings", clearNeverSave: true }) }, t("clear")))
        : null,
      row("shield", t("defaultManager"), t("defaultManagerHint"), toggle(t("defaultManager"), s.settings.defaultManager, defaultManager)),
    ),
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
      row(
        "eye",
        t("theme"),
        undefined,
        h(
          "select",
          {
            "aria-label": t("theme"),
            onchange: (e: Event) => {
              localStorage.setItem("theme", (e.target as HTMLSelectElement).value);
              applyTheme();
            },
          },
          ...THEMES.map((v) => h("option", { value: v, selected: v === savedTheme() }, t(`theme_${v}`))),
        ),
      ),
      row("lock", t("lockOnSystemLock"), undefined, h("span", { class: "switch" }, sysLock, h("span"))),
      row("key", t("passkeys"), t("passkeysHint"), h("span", { class: "switch" }, passkeys, h("span"))),
    ),
    h(
      "div",
      { class: "group" },
      inPanel || windowId === undefined
        ? null
        : row("panel", t("openSidePanel"), undefined, null, {
            type: "button",
            // sidePanel.open needs the user gesture, so no await before it.
            onclick: () => void chrome.sidePanel.open({ windowId: windowId! }).then(() => window.close(), (e: unknown) => ((ui.error = String(e)), render())),
          }, "button"),
      row("lock", t("lockNow"), undefined, null, { type: "button", onclick: () => void act({ type: "lock" }) }, "button"),
      row("logout", t("logOut"), undefined, null, { type: "button", class: "row danger", onclick: () => void act({ type: "logout" }) }, "button"),
    ),
    errorBox(),
  );
}

function unlockedView(s: State): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(
    ui.tab === "settings" ? settingsTab(s) : ui.tab === "generator" ? generatorScreen(vaultCtx) : ui.tab === "send" ? sendScreen(vaultCtx) : vaultScreen(vaultCtx),
    h(
      "nav",
      { class: "nav", "aria-label": t("navigation") },
      navButton("vault", t("vault"), "home"),
      navButton("generator", t("generator"), "dice"),
      navButton("send", t("send"), "send"),
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
  if (s.phase !== "twoFactor") ui.webauthnPaused = false;
  if (s.phase !== "unlocked") {
    ui.tab = "vault"; // a new session always starts on the vault
    resetVault(); // and holds no decrypted data from the previous one
    resetSend();
  }
  let view: Node;
  if (s.phase === "setup" || ui.editServer) view = setupView();
  else if (s.phase === "loggedOut") view = loginView();
  else if (s.phase === "twoFactor") view = twoFactorView(s);
  else if (s.phase === "locked") view = lockedView(s);
  else if (passkeyRequestId) view = passkeyScreen(vaultCtx);
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

// Fetched up front so the side panel button can call sidePanel.open synchronously in its click.
let windowId: number | undefined;
if (!inPanel) void chrome.windows.getCurrent().then((w) => (windowId = w.id));

void send<State>({ type: "getState" }).then((res) => {
  if (res.ok) state = res.data;
  else {
    state = { phase: "setup", settings: { autoLockMinutes: 15, lockOnSystemLock: true, passkeys: false, inlineMenu: true, savePrompt: true, neverSave: [], defaultManager: false } };
    ui.error = res.error;
  }
  draft.email = state.email ?? "";
  ui.error ??= state.ssoError;
  render();
});
