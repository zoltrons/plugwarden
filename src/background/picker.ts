// "Pick from page" in the item editor. The popup closes as soon as the user clicks the page, so its unsaved
// draft waits in the offscreen worker, where decrypted items live and a lock drops it.
import { activeTab, httpUrl } from "./autofill.ts";
import { UserError } from "./account.ts";
import { coreCall } from "./core.ts";
import { analyzeFocus } from "./engine.ts";
import type { CollectedPageDetails } from "../shared/messages.ts";
import { getSession, updateSession } from "./store.ts";

export interface PickedField {
  name: string;
  fieldType: string;
  label?: string;
  /** What the engine thinks it holds. Page-controlled, like the rest: it only sets a default the user sees. */
  autofillType?: string;
}

export interface FieldPick {
  draft: string;
  field?: PickedField;
}

const inFrames = (tabId: number, type: "pickerStart" | "pickerStop") => chrome.tabs.sendMessage(tabId, { type });

export async function startFieldPicker(draft: string, panel: boolean): Promise<null> {
  const tab = await activeTab();
  const tabId = tab?.id;
  if (tabId === undefined || !httpUrl(tab)) throw new UserError("invalid", chrome.i18n.getMessage("pickFieldNoPage"));
  try {
    await inFrames(tabId, "pickerStart");
  } catch {
    // Opened before the extension was installed or updated: its frames have no content script yet.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["page.js", "content.js"] }).catch(() => {
      throw new UserError("invalid", chrome.i18n.getMessage("pickFieldNoPage"));
    });
    await inFrames(tabId, "pickerStart");
  }
  await coreCall({ op: "stashDraft", draft });
  await updateSession({ picker: { tabId, panel } });
  return null;
}

/** From the frame the user picked in; an empty name is Escape. The other frames stop too. */
export async function finishFieldPicker(tabId: number, pick: { name: string; fieldType: string; label?: string; details?: CollectedPageDetails }): Promise<void> {
  const { picker } = await getSession();
  if (picker?.tabId !== tabId) return;
  // A field the engine cannot read is still the user's pick: it just gets no suggestion.
  const autofillType = pick.details ? await analyzeFocus(pick.details).then((a) => a.autofillType, () => undefined) : undefined;
  const field: PickedField | undefined = pick.name ? { name: pick.name, fieldType: pick.fieldType, label: pick.label, autofillType } : undefined;
  await updateSession({ picker: { ...picker, done: true, field } });
  await inFrames(tabId, "pickerStop").catch(() => undefined);
  if (picker.panel) await chrome.runtime.sendMessage({ type: "pickerDone" }).catch(() => undefined);
  else await chrome.action.openPopup().catch(() => undefined); // if refused, the draft waits for the next open
}

/** One-shot, whenever the popup opens: the draft to go back to. Opening it also ends a picker still running. */
export async function takeFieldPick(): Promise<FieldPick | null> {
  const { picker } = await getSession();
  if (!picker) return null;
  await updateSession({ picker: undefined });
  if (!picker.done) await inFrames(picker.tabId, "pickerStop").catch(() => undefined);
  const draft = await coreCall<string | null>({ op: "takeDraft" });
  return draft ? { draft, field: picker.field } : null;
}
