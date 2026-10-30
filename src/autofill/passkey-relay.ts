// Isolated-world relay between the page shim (passkey-page.ts) and the service worker. Registered on
// every secure origin. Each call gets its own port; pings keep the service worker alive while the user
// decides in the approval window (or while a conditional request waits for the inline menu). A closed
// port means "let the browser handle it"; an "abort" from the page drops the pending request.
const PORT = "plugwarden-passkey"; // PASSKEY_PORT in shared/messages.ts (kept import-free: content script)

/** Live calls by page call id, so an AbortSignal can cancel the matching pending request. */
const ports = new Map<string, chrome.runtime.Port>();

addEventListener("message", (ev: MessageEvent) => {
  const d = ev.data as { plugwarden?: unknown; id?: unknown; kind?: unknown; conditional?: unknown; options?: unknown } | null;
  if (ev.source !== window) return;
  if (d?.plugwarden === "abort") {
    const id = String(d.id);
    const port = ports.get(id);
    if (!port) return;
    ports.delete(id);
    port.postMessage({ abort: true });
    port.disconnect();
    return;
  }
  if (d?.plugwarden !== "req") return;
  const id = String(d.id);
  // Any page script can forge this message: without a real click or key press (and with a flood of open
  // ports) the browser handles the call itself. Only a conditional get opens nothing on its own; the
  // service worker ignores `conditional` on a create, so it must not skip the check here either.
  if ((!(d.kind === "get" && d.conditional === true) && !navigator.userActivation.isActive) || ports.size >= 8) {
    postMessage({ plugwarden: "res", id: d.id, result: { fallback: true } }, "*");
    return;
  }
  const port = chrome.runtime.connect({ name: PORT });
  ports.set(id, port);
  let done = false;
  const reply = (result: unknown) => {
    if (done) return;
    done = true;
    clearInterval(ping);
    ports.delete(id);
    postMessage({ plugwarden: "res", id: d.id, result }, "*");
  };
  const ping = setInterval(() => {
    try {
      port.postMessage({ ping: true });
    } catch {
      clearInterval(ping);
    }
  }, 20_000);
  port.onMessage.addListener((result: unknown) => {
    reply(result);
    port.disconnect();
  });
  port.onDisconnect.addListener(() => reply({ fallback: true }));
  try {
    port.postMessage({ kind: d.kind, conditional: d.conditional === true, options: d.options });
  } catch {
    // The extension was reloaded or disabled between connect and the call: let the browser handle it.
    reply({ fallback: true });
  }
});
