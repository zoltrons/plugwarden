// Service-worker side of the offscreen crypto host.
import { type CoreRequest, type CoreResult, OFFSCREEN_TARGET } from "../shared/messages.ts";

const OFFSCREEN_URL = "offscreen.html";
let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.CLIPBOARD],
      justification:
        "Runs the vault crypto (WebAssembly) in a dedicated worker that holds the unlocked keys, and clears copied passwords from the clipboard.",
    })
    .finally(() => (creating = undefined));
  await creating;
}

export async function coreCall<T>(req: CoreRequest): Promise<T> {
  await ensureOffscreen();
  const r = (await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, req })) as CoreResult | undefined;
  if (!r) throw new Error("offscreen document did not answer");
  if (!r.ok) throw new CoreError(r.error);
  return r.value as T;
}

export class CoreError extends Error {
  override name = "CoreError";
}

/** Drops all key material: terminates the worker and closes the offscreen document. */
export async function coreShutdown(): Promise<void> {
  if (!(await chrome.offscreen.hasDocument())) return;
  try {
    await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, req: { op: "lock" } });
  } finally {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

export const coreAlive = () => chrome.offscreen.hasDocument();
