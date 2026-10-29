// Page (MAIN world) shim, registered only when the user turns passkeys on. Routes public-key
// navigator.credentials.create/get calls to Plugwarden through the isolated relay (passkey-relay.ts)
// and falls back to the browser's own handling whenever Plugwarden declines.
// Not handled (browser handles them): conditional mediation (autofill UI), non-ES256 algorithms, AbortSignal.
(() => {
  const c = navigator.credentials;
  if (!c || !window.PublicKeyCredential) return;
  const create = c.create.bind(c);
  const get = c.get.bind(c);
  const b64u = (b: BufferSource) =>
    (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b)).toBase64({ alphabet: "base64url", omitPadding: true });
  const buf = (s: string) => Uint8Array.fromBase64(s, { alphabet: "base64url" }).buffer;
  let next = 0;

  type Result = { credential: Record<string, any> } | { fallback: true } | { error: { name: string; message: string } };
  const ask = (kind: "create" | "get", options: unknown) =>
    new Promise<Result>((resolve) => {
      const id = `${Date.now()}-${++next}`;
      const on = (ev: MessageEvent) => {
        if (ev.source !== window || ev.data?.plugwarden !== "res" || ev.data.id !== id) return;
        removeEventListener("message", on);
        resolve(ev.data.result as Result);
      };
      addEventListener("message", on);
      postMessage({ plugwarden: "req", id, kind, options }, "*");
    });

  // Plain objects with the right prototypes: own data properties shadow the native getters.
  function credential(r: Record<string, any>, kind: "create" | "get"): PublicKeyCredential {
    const response =
      kind === "create"
        ? {
            clientDataJSON: buf(r.clientDataJSON),
            attestationObject: buf(r.attestationObject),
            getAuthenticatorData: () => buf(r.authenticatorData),
            getPublicKey: () => buf(r.publicKey),
            getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
            getTransports: () => r.transports,
          }
        : {
            clientDataJSON: buf(r.clientDataJSON),
            authenticatorData: buf(r.authenticatorData),
            signature: buf(r.signature),
            userHandle: r.userHandle ? buf(r.userHandle) : null,
          };
    Object.setPrototypeOf(response, (kind === "create" ? AuthenticatorAttestationResponse : AuthenticatorAssertionResponse).prototype);
    const { id, ...json } = r;
    const cred = {
      id,
      rawId: buf(id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({ id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: json }),
    };
    Object.setPrototypeOf(cred, PublicKeyCredential.prototype);
    return cred as unknown as PublicKeyCredential;
  }

  const settle = async (kind: "create" | "get", options: unknown, fallback: () => Promise<Credential | null>) => {
    const r = await ask(kind, options);
    if ("credential" in r) return credential(r.credential, kind);
    if ("error" in r) throw new DOMException(r.error.message, r.error.name);
    return fallback();
  };

  c.create = (opts?: CredentialCreationOptions) => {
    const pk = opts?.publicKey;
    if (!pk || !pk.pubKeyCredParams.some((p) => p.alg === -7)) return create(opts);
    return settle(
      "create",
      {
        rpId: pk.rp.id,
        rpName: pk.rp.name,
        user: { id: b64u(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
        challenge: b64u(pk.challenge),
        exclude: (pk.excludeCredentials ?? []).map((x) => b64u(x.id)),
        discoverable: pk.authenticatorSelection?.residentKey !== "discouraged",
      },
      () => create(opts),
    );
  };

  c.get = (opts?: CredentialRequestOptions) => {
    const pk = opts?.publicKey;
    if (!pk || opts.mediation === "conditional") return get(opts);
    return settle("get", { rpId: pk.rpId, challenge: b64u(pk.challenge), allow: (pk.allowCredentials ?? []).map((x) => b64u(x.id)) }, () => get(opts));
  };
})();
