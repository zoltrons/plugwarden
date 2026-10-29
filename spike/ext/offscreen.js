// Phase 0 measurements inside a real MV3 offscreen document (Chromium 156).
const now = () => performance.now();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 10) / 10;

async function time(n, fn) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    await fn();
    runs.push(now() - t);
  }
  return { median: round(median(runs)), runs: runs.map(round) };
}

async function bench({ runs = 3, ciphers = 1000 }) {
  const out = {};

  // 1. Cold instantiate of our module (fetch + streaming compile + instantiate + glue).
  let t = now();
  const wasm = await import("./core_wasm.js");
  out.importGlueMs = round(now() - t);
  t = now();
  const inst = await wasm.default({ module_or_path: new URL("core_wasm_bg.wasm", import.meta.url) });
  out.coldInitMs = round(now() - t);
  out.wasmMemoryAfterInitMiB = round(inst.memory.buffer.byteLength / 2 ** 20);

  // 2. Compile-only comparison, bytes already in memory (no cache).
  const ours = await (await fetch("core_wasm_bg.wasm")).arrayBuffer();
  out.oursCompile = await time(runs, () => WebAssembly.compile(ours));
  try {
    const official = await (await fetch("official_bg.wasm")).arrayBuffer();
    out.officialBytes = official.byteLength;
    out.officialCompile = await time(runs, () => WebAssembly.compile(official));
  } catch (e) {
    out.officialCompile = String(e);
  }

  // 3. KDFs.
  const email = "bench@example.com", pw = "correct horse battery staple";
  const kdfs = {
    pbkdf2_600k: [0, 600000, 0, 0],
    argon2id_3it_64MiB_p4: [1, 3, 64, 4], // Bitwarden client default
    argon2id_6it_32MiB_p4: [1, 6, 32, 4], // sdk-internal test-vector params
  };
  out.kdf = {};
  for (const [name, p] of Object.entries(kdfs)) {
    out.kdf[name] = await time(runs, () => wasm.freeMasterKey(wasm.deriveMasterKey(pw, email, ...p)));
  }
  out.wasmMemoryAfterKdfMiB = round(inst.memory.buffer.byteLength / 2 ** 20);

  // Reference: WebCrypto PBKDF2-SHA256 600k (master key only).
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  out.webcryptoPbkdf2_600k = await time(runs, () =>
    crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(email), iterations: 600000 }, base, 256),
  );

  // 4. Unlock + batch decrypt (needs the `register` build to mint a protected user key).
  if (wasm.makeRegistrationKeys) {
    const h = wasm.deriveMasterKey(pw, email, 0, 600000, 0, 0);
    const reg = JSON.parse(wasm.makeRegistrationKeys(h));
    t = now();
    wasm.unlockUserKey(h, reg.key, reg.encryptedPrivateKey);
    out.unlockAfterKdfMs = round(now() - t);

    const plain = (i) => ({
      id: `id-${i}`, type: 1, name: `Item ${i}`, notes: i % 5 ? null : "some notes ".repeat(10),
      login: { username: `user${i}@example.com`, password: `pw-${i}-${"x".repeat(16)}`, totp: null,
        uris: [{ uri: `https://site${i}.example.com/login`, match: null }] },
      fields: i % 3 ? null : [{ name: "pin", value: "1234", type: 1 }],
    });
    t = now();
    const enc = [];
    for (let i = 0; i < ciphers; i++) enc.push(JSON.parse(wasm.encryptCipher(JSON.stringify(plain(i)))));
    out.encrypt = { ciphers, ms: round(now() - t) };
    const encJson = JSON.stringify(enc);
    out.decrypt = await time(runs, () => {
      const r = JSON.parse(wasm.decryptCipherList(encJson));
      if (r.ciphers.length !== ciphers || r.failed.length) throw new Error("decrypt mismatch");
    });
    out.decrypt.ciphers = ciphers;
    out.wasmMemoryAfterDecryptMiB = round(inst.memory.buffer.byteLength / 2 ** 20);
    out.totp = wasm.totp("JBSWY3DPEHPK3PXP", Date.now());
    out.generated = wasm.generatePassword('{"length":20,"special":true}').length;
    wasm.lock();
  }
  out.userAgent = navigator.userAgent;
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== "offscreen" || msg.cmd !== "bench") return;
  bench(msg.opts ?? {}).then(reply, (e) => reply({ error: String(e?.stack ?? e) }));
  return true;
});
