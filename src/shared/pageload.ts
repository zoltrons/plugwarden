// Page-load autofill selection, kept pure so the official client's rules can be unit tested.
// Mirrors clients: a login's tri-state `autofillOnPageLoad` decides whether it takes part, then the
// login last used for the site wins, else the first by name.
import type { VaultItem } from "./messages.ts";

export function pickPageLoadLogin(items: VaultItem[], defaultOn: boolean, lastUsed: Record<string, number> = {}): VaultItem | undefined {
  const candidates = items.filter(
    (i) => i.type === 1 && !i.failed && (i.autofillOnPageLoad === true || (i.autofillOnPageLoad === undefined && defaultOn)),
  );
  return candidates.sort((a, b) => (lastUsed[b.id] ?? 0) - (lastUsed[a.id] ?? 0) || a.name.localeCompare(b.name))[0];
}
