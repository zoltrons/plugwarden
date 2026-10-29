// Popup. Talks only to the service worker through the typed message bus: no crypto, no network.
import { AUTO_LOCK_CHOICES, CLEAR_CLIPBOARD_CHOICES, type ClearClipboardDelay, TWO_FACTOR, URI_MATCH, URI_MATCH_ADVANCED } from "../shared/constants.ts";
import type { Request, State } from "../shared/messages.ts";
import { normalizeServerUrl, originPattern } from "../shared/url.ts";
import { applyTheme, type Child, h, inPanel, savedTheme, send, t, THEMES, withChevron } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { createBiometricCredential, getBiometricPrf, platformAuthenticatorAvailable } from "./biometric.ts";
import { passkeyRequestId, passkeyScreen } from "./passkey.ts";
import { resetSend, sendScreen } from "./send.ts";
import { type Ctx, generatorScreen, iconButton, refreshPageMatches, resetVault, setIconBase, toastEl, uriMatchLabel, vaultRouteKey, vaultScreen } from "./vault.ts";

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
  /** Locked view: master password instead of the PIN. */
  usePassword?: boolean;
  /** Settings: the PIN form is open. */
  pinSetup?: boolean;
  /** Settings: the export form (master password) is open. */
  exporting?: boolean;
}

const draft = { server: "", email: "", password: "", code: "", pin: "", remember: false };
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

function bound(key: "server" | "email" | "password" | "code" | "pin", props: Record<string, unknown>) {
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
  const supported: number[] = [TWO_FACTOR.Authenticator, TWO_FACTOR.Email, TWO_FACTOR.YubiKey, TWO_FACTOR.WebAuthn].filter(
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
          offered.includes(TWO_FACTOR.YubiKey) ? chip(TWO_FACTOR.YubiKey, t("providerYubiKey"), "key") : null,
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
    ui.provider === TWO_FACTOR.YubiKey ? h("p", { class: "note" }, t("yubiKeyHint")) : null,
    typed
      ? field({
          icon: "lock",
          label: t("verificationCode"),
          extraClass: ui.provider === TWO_FACTOR.YubiKey ? undefined : "code",
          // A YubiKey OTP is 44 modhex letters typed by the key itself.
          input: bound(
            "code",
            ui.provider === TWO_FACTOR.YubiKey
              ? { autocomplete: "off", spellcheck: false, required: true, "data-autofocus": "1" }
              : { inputMode: "numeric", autocomplete: "one-time-code", required: true, "data-autofocus": "1" },
          ),
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

async function setupBiometric(): Promise<void> {
  const email = state?.email;
  if (!email) return;
  Object.assign(ui, { busy: true, busyLabel: t("busyBiometric"), error: undefined, info: undefined });
  render();
  try {
    const credential = await createBiometricCredential(email);
    if (await act({ type: "setBiometric", ...credential })) {
      ui.info = t("biometricEnabled");
      render();
    }
  } catch (e) {
    Object.assign(ui, { busy: false, busyLabel: undefined, error: (e as Error).message });
    render();
  }
}

async function disableBiometric(): Promise<void> {
  if (await act({ type: "removeBiometric" })) {
    ui.info = t("biometricRemoved");
    render();
  }
}

/** Locked screen: biometric assertion, then the PRF-wrapped user key in the crypto worker. */
async function unlockBiometric(bio: { credentialId: string; prfSalt: string }): Promise<void> {
  Object.assign(ui, { busy: true, busyLabel: t("busyVerifying"), error: undefined, info: undefined });
  render();
  try {
    const prf = await getBiometricPrf(bio.credentialId, bio.prfSalt);
    await act({ type: "unlockBiometric", prf });
  } catch (e) {
    Object.assign(ui, { busy: false, busyLabel: undefined, error: (e as Error).message });
    render();
  }
}

function lockedView(s: State): HTMLElement {
  const withPin = !!s.pinUnlock && !ui.usePassword;
  const onsubmit = (e: Event) => {
    e.preventDefault();
    const [password, pin] = [draft.password, draft.pin];
    draft.password = draft.pin = "";
    void act(withPin ? { type: "unlockPin", pin } : { type: "unlock", password }, t("busyUnlocking"));
  };
  const pinField = () =>
    field({ icon: "lock", label: t("pin"), input: bound("pin", { type: "password", autocomplete: "off", required: true, spellcheck: false, "data-autofocus": "1" }) });
  const switchMethod = s.pinUnlock
    ? h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: () => ((ui.usePassword = !ui.usePassword), (ui.error = undefined), render()) }, t(withPin ? "useMasterPassword" : "usePin"))
    : null;
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
    s.biometric
      ? h(
          "div",
          { class: "actions" },
          h(
            "button",
            { type: "button", class: "btn tonal wide", disabled: ui.busy, onclick: () => void unlockBiometric(s.biometric!) },
            icon("fingerprint"),
            t("unlockWithBiometrics"),
          ),
          !inPanel && !inTab
            ? h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: () => void chrome.tabs.create({ url: location.href }) }, t("openInTab"))
            : null,
        )
      : null,
    withPin ? pinField() : passwordField("current-password"),
    errorBox(),
    busyBar(),
    h(
      "div",
      { class: "actions" },
      submitButton(t("unlock")),
      switchMethod,
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
      onclick: () => {
        ui.tab = tab;
        // The "On this site" matches depend on settings edited in another tab; refresh on return.
        if (tab === "vault") void refreshPageMatches().then(render, render);
        else render();
      },
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

function clearClipboardLabel(v: ClearClipboardDelay): string {
  const key = {
    never: "never",
    tenSeconds: "tenSeconds",
    twentySeconds: "twentySeconds",
    thirtySeconds: "thirtySeconds",
    oneMinute: "oneMinute",
    twoMinutes: "twoMinutes",
    fiveMinutes: "fiveMinutes",
  }[v];
  return t(key);
}

function openExternal(url: string) {
  void chrome.tabs.create({ url });
}

async function syncNow() {
  Object.assign(ui, { busy: true, busyLabel: t("syncing"), error: undefined, info: undefined });
  render();
  const r = await send<unknown>({ type: "sync", force: true });
  ui.busy = false;
  ui.busyLabel = undefined;
  if (!r.ok) ui.error = r.error;
  else {
    const next = await send<State>({ type: "getState" });
    if (next.ok) state = next.data;
    ui.info = t("syncComplete");
    resetVault();
  }
  render();
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
      s.settings.inlineMenu
        ? row("card", t("inlineMenuCards"), undefined, toggle(t("inlineMenuCards"), s.settings.inlineMenuCards, (b) => void act({ type: "setSettings", inlineMenuCards: b.checked })))
        : null,
      s.settings.inlineMenu
        ? row("user", t("inlineMenuIdentities"), undefined, toggle(t("inlineMenuIdentities"), s.settings.inlineMenuIdentities, (b) => void act({ type: "setSettings", inlineMenuIdentities: b.checked })))
        : null,
      row("card", t("showCardsOnTab"), undefined, toggle(t("showCardsOnTab"), s.settings.showCardsOnTab, (b) => void act({ type: "setSettings", showCardsOnTab: b.checked }))),
      row("user", t("showIdentitiesOnTab"), undefined, toggle(t("showIdentitiesOnTab"), s.settings.showIdentitiesOnTab, (b) => void act({ type: "setSettings", showIdentitiesOnTab: b.checked }))),
      row("timer", t("autoCopyTotp"), t("autoCopyTotpHint"), toggle(t("autoCopyTotp"), s.settings.autoCopyTotp, (b) => void act({ type: "setSettings", autoCopyTotp: b.checked }))),
      row("more", t("enableContextMenu"), undefined, toggle(t("enableContextMenu"), s.settings.contextMenu, (b) => void act({ type: "setSettings", contextMenu: b.checked }))),
      row("plus", t("savePrompt"), t("savePromptHint"), toggle(t("savePrompt"), s.settings.savePrompt, (b) => void act({ type: "setSettings", savePrompt: b.checked }))),
      s.settings.neverSave.length
        ? row("globe", t("neverSaveSites", String(s.settings.neverSave.length)), s.settings.neverSave.join(", "), h("button", { type: "button", class: "btn text small", onclick: () => void act({ type: "setSettings", clearNeverSave: true }) }, t("clear")))
        : null,
      ...s.settings.neverSave.map((h0) =>
        row("globe", h0, undefined, iconButton("close", t("removeNeverSave", h0), () => void act({ type: "setSettings", removeNeverSave: h0 }))),
      ),
      row("shield", t("defaultManager"), t("defaultManagerHint"), toggle(t("defaultManager"), s.settings.defaultManager, defaultManager)),
    ),
    h("h2", { class: "section-title" }, t("autofillOnPageLoad")),
    h(
      "div",
      { class: "group" },
      row(
        "timer",
        t("autofillOnPageLoad"),
        t("autofillOnPageLoadHint"),
        toggle(t("autofillOnPageLoad"), s.settings.autofillOnPageLoad, (b) => void act({ type: "setSettings", autofillOnPageLoad: b.checked })),
      ),
      s.settings.autofillOnPageLoad
        ? row(
            "key",
            t("autofillOnPageLoadDefault"),
            t("autofillOnPageLoadDefaultHint"),
            h(
              "select",
              {
                "aria-label": t("autofillOnPageLoadDefault"),
                onchange: (e: Event) => void act({ type: "setSettings", autofillOnPageLoadDefault: (e.target as HTMLSelectElement).value === "true" }),
              },
              h("option", { value: "true", selected: s.settings.autofillOnPageLoadDefault }, t("on")),
              h("option", { value: "false", selected: !s.settings.autofillOnPageLoadDefault }, t("off")),
            ),
          )
        : null,
    ),
    h("h2", { class: "section-title" }, t("additionalOptions")),
    h(
      "div",
      { class: "group" },
      row(
        "timer",
        t("clearClipboard"),
        t("clearClipboardDesc"),
        h(
          "select",
          {
            "aria-label": t("clearClipboard"),
            onchange: (e: Event) => void act({ type: "setSettings", clearClipboardDelay: (e.target as HTMLSelectElement).value as ClearClipboardDelay }),
          },
          ...CLEAR_CLIPBOARD_CHOICES.map((v) => h("option", { value: v, selected: v === s.settings.clearClipboardDelay }, clearClipboardLabel(v))),
        ),
      ),
      row(
        "globe",
        t("defaultUriMatchDetection"),
        t(URI_MATCH_ADVANCED.includes(s.settings.defaultUriMatch) ? "uriMatchDefaultAdvancedHint" : "uriMatchDefaultHint"),
        h(
          "select",
          {
            "aria-label": t("defaultUriMatchDetection"),
            onchange: (e: Event) => void act({ type: "setSettings", defaultUriMatch: Number((e.target as HTMLSelectElement).value) }),
          },
          ...[URI_MATCH.Domain, URI_MATCH.Host, URI_MATCH.Exact, URI_MATCH.Never, URI_MATCH.StartsWith, URI_MATCH.RegularExpression].map((m) =>
            h("option", { value: String(m), selected: m === s.settings.defaultUriMatch }, uriMatchLabel(m)),
          ),
        ),
      ),
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
      row("timer", t("autoLock"), undefined, withChevron(select)),
      row(
        "logout",
        t("timeoutAction"),
        undefined,
        withChevron(
          h(
            "select",
            { "aria-label": t("timeoutAction"), onchange: (e: Event) => void act({ type: "setSettings", timeoutAction: (e.target as HTMLSelectElement).value as "lock" | "logout" }) },
            h("option", { value: "lock", selected: s.settings.timeoutAction === "lock" }, t("lock")),
            h("option", { value: "logout", selected: s.settings.timeoutAction === "logout" }, t("logOut")),
          ),
        ),
      ),
      row(
        "eye",
        t("theme"),
        undefined,
        withChevron(
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
      ),
      row("globe", t("favicons"), t("faviconsHint"), toggle(t("favicons"), s.settings.favicons, (b) => void act({ type: "setSettings", favicons: b.checked }))),
      row("lock", t("lockOnSystemLock"), undefined, h("span", { class: "switch" }, sysLock, h("span"))),
      row(
        "key",
        t("unlockWithPin"),
        t("unlockWithPinHint"),
        toggle(t("unlockWithPin"), !!s.pinSet || !!ui.pinSetup, (b) => (b.checked ? ((ui.pinSetup = true), render()) : void act({ type: "setPin" }))),
      ),
      row(
        "fingerprint",
        t("biometricUnlock"),
        t("biometricUnlockHint"),
        toggle(t("biometricUnlock"), !!s.biometric, (b) => void (b.checked ? setupBiometric() : disableBiometric())),
      ),
      ui.pinSetup && !s.pinSet
        ? h(
            "form",
            {
              class: "row",
              onsubmit: async (e: Event) => {
                e.preventDefault();
                const pin = draft.pin;
                draft.pin = "";
                if (await act({ type: "setPin", pin })) ui.pinSetup = false;
                render();
              },
            },
            h("input", { type: "password", autocomplete: "off", required: true, "aria-label": t("pin"), placeholder: t("pin"), value: draft.pin, oninput: (e: Event) => (draft.pin = (e.target as HTMLInputElement).value) }),
            h("button", { type: "submit", class: "btn tonal small" }, t("setPin")),
          )
        : null,
    ),
    h("h2", { class: "section-title" }, t("vault")),
    h(
      "div",
      { class: "group" },
      row(
        "refresh",
        t("syncNow"),
        s.syncedAt ? t("lastSync", new Date(s.syncedAt).toLocaleString()) : t("never"),
        h("button", { type: "button", class: "btn text small", disabled: ui.busy, onclick: () => void syncNow() }, icon("refresh"), t("syncNow")),
      ),
      row("download", t("exportVault"), t("exportHint"), null, { type: "button", disabled: ui.busy, onclick: () => ((ui.exporting = !ui.exporting), render()) }, "button"),
      ui.exporting
        ? h(
            "form",
            {
              class: "row",
              onsubmit: (e: Event) => {
                e.preventDefault();
                const password = draft.password;
                draft.password = "";
                void exportVault(password);
              },
            },
            h("input", { type: "password", autocomplete: "current-password", required: true, "aria-label": t("masterPassword"), placeholder: t("masterPassword"), value: draft.password, oninput: (e: Event) => (draft.password = (e.target as HTMLInputElement).value) }),
            h("button", { type: "submit", class: "btn tonal small", disabled: ui.busy }, t("exportConfirm")),
          )
        : null,
      h(
        "label",
        { class: "row" },
        icon("plus"),
        h("div", { class: "body" }, h("span", { class: "title" }, t("importVault")), h("span", { class: "sub" }, t("importHint"))),
        h("input", { type: "file", accept: ".json,application/json", class: "sr-only", "aria-label": t("importVault"), disabled: ui.busy, onchange: (e: Event) => void importVault((e.target as HTMLInputElement).files?.[0]) }),
      ),
    ),
    busyBar(),
    ui.info ? h("p", { class: "note", role: "status" }, ui.info) : null,
    h("h2", { class: "section-title" }, t("about")),
    h(
      "div",
      { class: "group" },
      row("info", t("about"), chrome.runtime.getManifest().version),
      row("globe", t("helpCenter"), undefined, null, { type: "button", onclick: () => openExternal("https://bitwarden.com/help/") }, "button"),
      s.serverUrl ? row("vault", t("webVault"), host(s.serverUrl), null, { type: "button", onclick: () => openExternal(`${s.serverUrl}/#/`) }, "button") : null,
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
      // The OS biometric prompt can close the action popup; setup and unlock also work in a tab.
      !inPanel && !inTab
        ? row("external", t("openInTab"), t("openInTabHint"), null, { type: "button", onclick: () => void chrome.tabs.create({ url: location.href }) }, "button")
        : null,
      row("lock", t("lockNow"), undefined, null, { type: "button", onclick: () => void act({ type: "lock" }) }, "button"),
      row("logout", t("logOut"), undefined, null, { type: "button", class: "row danger", onclick: () => void act({ type: "logout" }) }, "button"),
    ),
    errorBox(),
  );
}

async function exportVault(password: string) {
  Object.assign(ui, { busy: true, error: undefined, info: undefined });
  render();
  const r = await send<string>({ type: "exportVault", password });
  ui.busy = false;
  if (r.ok) {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const url = URL.createObjectURL(new Blob([r.data], { type: "application/json" }));
    h("a", { href: url, download: `plugwarden_export_${stamp}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    ui.exporting = false;
  } else ui.error = r.error;
  render();
}

async function importVault(file: File | undefined) {
  if (!file) return;
  Object.assign(ui, { busy: true, error: undefined, info: undefined });
  render();
  const r = await send<{ imported: number; skipped: number }>({ type: "importVault", text: await file.text() });
  ui.busy = false;
  if (r.ok) {
    ui.info = t("imported", String(r.data.imported)) + (r.data.skipped ? ` ${t("importSkipped", String(r.data.skipped))}` : "");
    resetVault(); // the list reloads with the new items
  } else ui.error = r.error;
  render();
}

function unlockedView(s: State): DocumentFragment {
  // Detail screens (item, editor, folders, passkey approval) drop the tab bar: they are a
  // drill-down with their own back action, exactly like the reference app.
  const detail = !!passkeyRequestId || (ui.tab === "vault" && vaultRouteKey() !== "list");
  const frag = document.createDocumentFragment();
  frag.append(
    ...[
      ui.tab === "settings" ? settingsTab(s) : ui.tab === "generator" ? generatorScreen(vaultCtx) : ui.tab === "send" ? sendScreen(vaultCtx) : vaultScreen(vaultCtx),
      detail
        ? null
        : h(
            "nav",
            { class: "nav", "aria-label": t("navigation") },
            navButton("vault", t("vault"), "home"),
            navButton("generator", t("generator"), "dice"),
            navButton("send", t("send"), "send"),
            navButton("settings", t("settings"), "settings"),
          ),
      toastEl() || "",
    ].filter((x): x is Exclude<typeof x, null> => x !== null),
  );
  return frag;
}

// ---------- render ----------

const app = document.getElementById("app")!;
const vaultCtx: Ctx = {
  rerender: () => render(),
  lock: () => void act({ type: "lock" }),
  email: () => state?.email,
  settings: () => state?.settings,
};
let firstRender = true;

/** One scroll offset per screen, so coming back from an item lands where the user left. */
const scrollMemory = new Map<string, number>();
let lastScreen = "";

function screenKey(): string {
  if (!state) return "boot";
  if (state.phase === "setup" || ui.editServer) return "setup";
  if (state.phase !== "unlocked") return state.phase;
  if (passkeyRequestId) return "passkey";
  return ui.tab === "vault" ? `vault:${vaultRouteKey()}` : ui.tab;
}

function render(): void {
  if (!state) return;
  const s = state;
  if (s.phase !== "twoFactor") ui.webauthnPaused = false;
  setIconBase(s.settings.favicons && s.serverUrl ? `${s.serverUrl}/icons` : undefined);
  if (s.phase !== "unlocked") {
    ui.tab = "vault"; // a new session always starts on the vault
    resetVault(); // and holds no decrypted data from the previous one
    resetSend();
    scrollMemory.clear(); // a locked or logged-out screen never restores a vault position
  }
  let view: Node;
  if (s.phase === "setup" || ui.editServer) view = setupView();
  else if (s.phase === "loggedOut") view = loginView();
  else if (s.phase === "twoFactor") view = twoFactorView(s);
  else if (s.phase === "locked") view = lockedView(s);
  else if (passkeyRequestId) view = passkeyScreen(vaultCtx);
  else view = unlockedView(s);

  const key = screenKey();
  if (lastScreen) scrollMemory.set(lastScreen, window.scrollY);
  const focused = document.activeElement?.id;
  app.replaceChildren(view);
  const again = focused ? document.getElementById(focused) : null;
  ((again ?? app.querySelector("[data-autofocus]")) as HTMLElement | null)?.focus({ preventScroll: true });
  window.scrollTo(0, scrollMemory.get(key) ?? 0);
  lastScreen = key;
  if (firstRender) {
    firstRender = false;
    performance.mark("plugwarden:first-render");
  }
}

// Test-only hook for tools/smoke-biometric.mjs (no Vaultwarden needed); compiled out of releases.
declare const E2E: boolean;
if (typeof E2E !== "undefined" && E2E) Object.assign(globalThis, { plugwardenBiometric: { createBiometricCredential, getBiometricPrf, platformAuthenticatorAvailable } });

// Fetched up front so the side panel button can call sidePanel.open synchronously in its click.
let windowId: number | undefined;
if (!inPanel) void chrome.windows.getCurrent().then((w) => (windowId = w.id));
// `getCurrent()` is undefined in the action popup: only there can the system prompt close the window.
let inTab = true;
if (!inPanel)
  void chrome.tabs.getCurrent().then((tab) => {
    inTab = !!tab;
    render();
  });

void send<State>({ type: "getState" }).then((res) => {
  if (res.ok) state = res.data;
  else {
    state = {
      phase: "setup",
      settings: {
        autoLockMinutes: 15, timeoutAction: "lock", lockOnSystemLock: true, inlineMenu: true, savePrompt: true, neverSave: [],
        defaultManager: false, favicons: true, autoCopyTotp: true, defaultUriMatch: 0, clearClipboardDelay: "fiveMinutes",
        autofillOnPageLoad: false, autofillOnPageLoadDefault: true, inlineMenuCards: true, inlineMenuIdentities: true, contextMenu: true,
        showCardsOnTab: true, showIdentitiesOnTab: true,
      },
    };
    ui.error = res.error;
  }
  draft.email = state.email ?? "";
  ui.error ??= state.ssoError;
  render();
});

/**
 * The worker owns the session (auto-lock, a lock from another window): follow it. Without this an open
 * side panel would keep showing decrypted item names after the vault locked.
 */
let refreshing = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.session || !state || refreshing) return;
  const next = changes.session.newValue as { unlocked?: unknown } | undefined;
  if (typeof next?.unlocked !== "boolean" || next.unlocked === (state.phase === "unlocked")) return;
  refreshing = true;
  void send<State>({ type: "getState" }).then((r) => {
    refreshing = false;
    if (!r.ok) return;
    state = r.data;
    render();
  });
});
