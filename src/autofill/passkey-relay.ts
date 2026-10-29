// Isolated-world relay between the page shim (passkey-page.ts) and the service worker. Registered
// only when passkeys are on. Each call gets its own port; pings keep the service worker alive while
// the user decides in the approval window. A closed port means "let the browser handle it".
const PORT = "plugwarden-passkey"; // PASSKEY_PORT in shared/messages.ts (kept import-free: content script)

addEventListener("message", (ev: MessageEvent) => {
  const d = ev.data as { plugwarden?: unknown; id?: unknown; kind?: unknown; options?: unknown } | null;
  if (ev.source !== window || d?.plugwarden !== "req") return;
  const port = chrome.runtime.connect({ name: PORT });
  let done = false;
  const reply = (result: unknown) => {
    if (done) return;
    done = true;
    clearInterval(ping);
    postMessage({ plugwarden: "res", id: d.id, result }, "*");
  };
  const ping = setInterval(() => port.postMessage({ ping: true }), 20_000);
  port.onMessage.addListener((result: unknown) => {
    reply(result);
    port.disconnect();
  });
  port.onDisconnect.addListener(() => reply({ fallback: true }));
  port.postMessage({ kind: d.kind, options: d.options });
});
