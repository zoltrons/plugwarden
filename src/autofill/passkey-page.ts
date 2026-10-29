// Page (MAIN world) shim, registered on every secure origin (https, localhost). Routes ES256
// public-key navigator.credentials.create/get calls to Plugwarden through the isolated relay
// (passkey-relay.ts) and falls back to the browser's own handling whenever Plugwarden declines.
// Conditional mediation (passkey autofill) is raced against the browser's native conditional UI:
// whichever answers first wins, and Plugwarden's side also drives the inline menu entry.
// Not handled (browser handles them): non-ES256 algorithms.
(() => {
  const c = navigator.credentials;
  if (!c || !window.PublicKeyCredential) return;
  const create = c.create.bind(c);
  const get = c.get.bind(c);
  // Like the official clients: when the browser reports no built-in authenticator, advertise one so
  // sites still offer passkey creation and passkey autofill (Plugwarden answers both).
  const pkc = window.PublicKeyCredential as unknown as Record<string, unknown>;
  for (const name of ["isUserVerifyingPlatformAuthenticatorAvailable", "isConditionalMediationAvailable"]) {
    const fn = pkc[name];
    if (typeof fn !== "function") continue;
    Promise.resolve((fn as () => Promise<boolean>).call(pkc)).then(
      (available) => {
        if (available) return;
        try {
          pkc[name] = () => Promise.resolve(true);
        } catch {
          // Read-only in this browser: leave its answer alone.
        }
      },
      () => undefined,
    );
  }
  const b64u = (b: BufferSource) =>
    (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b)).toBase64({ alphabet: "base64url", omitPadding: true });
  const buf = (s: string) => Uint8Array.fromBase64(s, { alphabet: "base64url" }).buffer;
  let next = 0;

  type Result = { credential: Record<string, any> } | { fallback: true } | { error: { name: string; message: string } };
  type Answer = { id: string; result: Result };

  /**
   * One call over the relay. `signal` mirrors the page's AbortSignal: aborting drops the pending
   * request in the service worker (and closes its approval window).
   */
  const ask = (kind: "create" | "get", options: unknown, conditional: boolean, signal?: AbortSignal | null) =>
    new Promise<Answer>((resolve, reject) => {
      const id = `${Date.now()}-${++next}`;
      const finish = (fn: () => void) => {
        removeEventListener("message", on);
        signal?.removeEventListener("abort", abort);
        fn();
      };
      const on = (ev: MessageEvent) => {
        if (ev.source !== window || ev.data?.plugwarden !== "res" || ev.data.id !== id) return;
        finish(() => resolve({ id, result: ev.data.result as Result }));
      };
      const abort = () => {
        postMessage({ plugwarden: "abort", id }, "*");
        finish(() => reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")));
      };
      if (signal?.aborted) return abort();
      addEventListener("message", on);
      signal?.addEventListener("abort", abort, { once: true });
      postMessage({ plugwarden: "req", id, kind, conditional, options }, "*");
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
    const { id, credProps, ...json } = r;
    const extensions = kind === "create" && credProps ? { credProps } : {};
    const cred = {
      id,
      rawId: buf(id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => extensions,
      toJSON: () => ({ id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: extensions, response: json }),
    };
    Object.setPrototypeOf(cred, PublicKeyCredential.prototype);
    return cred as unknown as PublicKeyCredential;
  }

  const options = (pk: PublicKeyCredentialRequestOptions) => ({
    rpId: pk.rpId,
    challenge: b64u(pk.challenge),
    allow: (pk.allowCredentials ?? []).map((x) => b64u(x.id)),
  });

  const settle = async (kind: "create" | "get", opts: unknown, fallback: () => Promise<Credential | null>, signal?: AbortSignal | null) => {
    const { result } = await ask(kind, opts, false, signal);
    if ("credential" in result) return credential(result.credential, kind);
    if ("error" in result) throw new DOMException(result.error.message, result.error.name);
    return fallback();
  };

  /** Conditional mediation: the browser's own passkey UI and Plugwarden's inline menu compete. */
  const conditionalGet = async (opts: CredentialRequestOptions, pk: PublicKeyCredentialRequestOptions) => {
    const aborted = () => opts.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
    if (opts.signal?.aborted) throw aborted();
    const mine = new AbortController();
    const native = new AbortController();
    const stop = () => {
      native.abort();
      mine.abort(); // drops Plugwarden's pending request (and its inline-menu entry)
    };
    const nativeCall = get({ ...opts, signal: native.signal });
    const answer = ask("get", options(pk), true, mine.signal);
    return await new Promise<Credential | null>((resolve, reject) => {
      const onAbort = () => {
        stop();
        reject(aborted());
      };
      const done = () => opts.signal?.removeEventListener("abort", onAbort);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      nativeCall.then(
        (cred) => {
          // The browser's UI answered: drop Plugwarden's pending request and its menu entry.
          if (!cred) return;
          stop();
          done();
          resolve(cred);
        },
        () => undefined, // browser UI dismissed or Plugwarden answered first
      );
      answer.then(
        ({ result }) => {
          if ("credential" in result) {
            stop();
            done();
            resolve(credential(result.credential, "get"));
          } else if ("error" in result) {
            stop();
            done();
            reject(new DOMException(result.error.message, result.error.name));
          }
          // fallback: keep waiting for the browser's own UI (and for its AbortSignal)
        },
        (e: unknown) => {
          stop();
          done();
          reject(e);
        },
      );
    });
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
      opts.signal,
    );
  };

  c.get = (opts?: CredentialRequestOptions) => {
    const pk = opts?.publicKey;
    if (!pk) return get(opts);
    if (opts.mediation === "conditional") return conditionalGet(opts, pk);
    return settle("get", options(pk), () => get(opts), opts.signal);
  };
})();
