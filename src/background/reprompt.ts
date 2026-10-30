// Master-password re-prompt (`reprompt`, set per item in the web vault): a user who flagged an item
// expects the master password to be asked again before its secrets are shown, copied or filled.
//
// The grant lives in memory only, per cipher, for a few minutes: a service-worker restart or a lock
// drops it, so the default is always "ask again". Enforcement happens in the service worker, not in the
// UI, so every path that returns secrets is covered (view, copy, fill, TOTP, attachments).
import type { VaultItem } from "../shared/messages.ts";
import { ci } from "../shared/validate.ts";

/** Bitwarden CipherRepromptType.Password. (None = 0.) */
const REPROMPT_PASSWORD = 1;

const GRANT_MS = 5 * 60_000;

/** cipher id -> epoch ms the confirmation expires. In memory on purpose. */
const grants = new Map<string, number>();

export const REPROMPT_MESSAGE = "Enter your master password in Plugwarden to use this item";

/**
 * True when the item (decrypted or a list summary) is flagged for a re-prompt. Case-insensitive like the
 * list summary: the decrypted cipher keeps the server's key casing, and a miss here would fail open.
 */
export const repromptRequired = (item: Record<string, unknown> | VaultItem | undefined): boolean =>
  Number(ci(item, "reprompt")) === REPROMPT_PASSWORD;

export function grantReprompt(id: string): void {
  grants.set(id, Date.now() + GRANT_MS);
}

export function repromptGranted(id: string): boolean {
  const until = grants.get(id);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    grants.delete(id);
    return false;
  }
  return true;
}

export const revokeReprompts = (): void => void grants.clear();

/** True when `item` needs a confirmation the user has not given in this session. */
export const repromptPending = (item: Record<string, unknown> | undefined): boolean =>
  repromptRequired(item) && !repromptGranted(String(ci(item, "id") ?? ""));
