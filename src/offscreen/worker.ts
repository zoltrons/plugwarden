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
    case "pinProtect": {
      const { type, iterations, memory, parallelism } = req.kdf;
      return core.pinProtectUserKey(req.pin, req.email, type, iterations, memory, parallelism);
    }
    case "prfProtect":
      return core.prfProtectUserKey(req.prf);
    case "unlockPrf":
      core.unlockWithPrf(req.prf, req.protectedUserKey, req.encryptedPrivateKey);
      return true;
    case "unlockPin": {
      const { type, iterations, memory, parallelism } = req.kdf;
      core.unlockWithPin(req.pin, req.email, type, iterations, memory, parallelism, req.protectedUserKey, req.encryptedPrivateKey);
      return true;
    }
    case "freeKey":
      core.freeMasterKey(req.handle);
      authHashes.delete(req.handle);
      return true;
    case "lock":
      core.lock();
      authHashes.clear();
      return true;
    case "vaultLoaded":
      return vault.loaded();
    case "loadVault":
      return vault.loadVault(req.ciphers, req.folders, req.sends, req.orgKeys, req.collections, req.orgs);
    case "upsertCipher":
      return vault.upsertCipher(req.cipher);
    case "listVault":
      return vault.listVault();
    case "getCipher":
      return vault.getCipher(req.id);
    case "cipherSummary":
      return vault.cipherSummary(req.id);
    case "prepareSave":
      return vault.prepareSave(req.item);
    case "totp":
      return vault.totp(req.id);
    case "generate":
      return vault.generate(req.options);
    case "encryptText":
      return req.values.map((name) => String(vault.prepareSave({ type: 2, name }).name));
    case "decryptText":
      return vault.decryptText(req.values);
    case "matchUri":
      return vault.matchUri(req.url, req.defaultMatch);
    case "fillData":
      return vault.fillData(req.id);
    case "formValues":
      return vault.formValues(req.id);
    case "customFieldValues":
      return vault.customFieldValues(req.id);
    case "stashDraft":
      return vault.stashDraft(req.draft);
    case "takeDraft":
      return vault.takeDraft();
    case "exportJson":
      return vault.exportJson();
    case "prepareImport":
      return vault.prepareImport(req.text);
    case "decryptAttachment":
      return vault.decryptAttachment(req.cipherId, req.attachmentId, req.data);
    case "encryptAttachment":
      return vault.encryptAttachment(req.cipherId, req.fileName, req.data);
    case "listSends":
      return vault.listSends();
    case "getSend":
      return vault.getSend(req.id);
    case "prepareSend":
      return vault.prepareSend(req.send);
    case "encryptSendFile":
      return vault.encryptSendFile(req.key, req.data);
    case "upsertSend":
      return vault.upsertSend(req.send);
    case "removeSend":
      return vault.removeSend(req.id);
    case "passkeyCandidates":
      return vault.passkeyCandidates(req.rpId, req.origin, req.ids);
    case "passkeyAssert":
      return vault.passkeyAssert(req.itemId, req.credentialId, req.rpId, req.origin, req.challenge);
    case "passkeyCreate":
      return vault.passkeyCreate(req.input);
  }
}

self.onmessage = async (ev: MessageEvent<{ id: number; req: unknown }>) => {
  const { id, req } = ev.data;
  let result: CoreResult;
  try {
    await ready;
    result = { ok: true, value: await run(parseCoreRequest(req)) };
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage({ id, result });
};
