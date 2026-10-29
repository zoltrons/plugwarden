// Dedicated worker spawned by the offscreen document. The only place the WASM module, the master
// key and the unlocked user key live. Terminating the worker drops all of it (incl. the WASM
// memory that Argon2id grew to 64+ MiB).
import init, * as core from "../../dist/wasm/core_wasm.js";
import { type CoreRequest, type CoreResult, parseCoreRequest } from "../shared/messages.ts";
import * as vault from "./vault.ts";

const ready = init({ module_or_path: new URL("core_wasm_bg.wasm", import.meta.url) });

/** Server auth hash per pending master key handle (needed again for 2FA / email code requests). */
const authHashes = new Map<number, string>();

function run(req: CoreRequest): unknown {
  switch (req.op) {
    case "prepareKey": {
      const { type, iterations, memory, parallelism } = req.kdf;
      const handle = core.deriveMasterKey(req.password, req.email, type, iterations, memory, parallelism);
      const authHash = core.makeAuthHash(handle, req.password, false);
      authHashes.set(handle, authHash);
      return { handle, authHash };
    }
    case "authHash": {
      const h = authHashes.get(req.handle);
      if (!h) throw new Error("unknown master key handle");
      return h;
    }
    case "unlock":
      core.unlockUserKey(req.handle, req.protectedUserKey, req.encryptedPrivateKey);
      authHashes.delete(req.handle);
      return true;
    case "freeKey":
      core.freeMasterKey(req.handle);
      authHashes.delete(req.handle);
      return true;
    case "lock":
      core.lock();
      authHashes.clear();
      return true;
    case "status":
      return { unlocked: core.isUnlocked() };
    case "loadVault":
      return vault.loadVault(req.ciphers, req.folders, req.orgKeys);
    case "upsertCipher":
      return vault.upsertCipher(req.cipher);
    case "removeCipher":
      return vault.removeCipher(req.id);
    case "listVault":
      return vault.listVault();
    case "getCipher":
      return vault.getCipher(req.id);
    case "prepareSave":
      return vault.prepareSave(req.item);
    case "totp":
      return vault.totp(req.id);
    case "generate":
      return vault.generate(req.options);
  }
}

self.onmessage = async (ev: MessageEvent<{ id: number; req: unknown }>) => {
  const { id, req } = ev.data;
  let result: CoreResult;
  try {
    await ready;
    result = { ok: true, value: run(parseCoreRequest(req)) };
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage({ id, result });
};
