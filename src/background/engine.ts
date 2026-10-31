// The bridge to the autofill engine (crates/autofill-core) and to the page. The engine decides, from what
// the frame reports, which field takes which value; it only ever sees names, never the values.
import init, { analyze_page, plan } from "../../dist/wasm/autofill_core.js";
import type { ExecuteFill, FillResult, ValueFormat } from "../autofill/types.ts";
import type { PageApi } from "../autofill/page.ts";
import { type CollectedPageDetails, type FieldKind, parsePageDetails } from "../shared/messages.ts";

// A global, but one that rebuilds itself: after the service worker restarts this just loads again.
let ready: ReturnType<typeof init> | undefined;
const engine = () => (ready ??= init({ module_or_path: new URL("autofill_core_bg.wasm", import.meta.url) }));

interface AnalyzedField {
  fieldId: number;
  menu?: FieldKind;
  signup?: boolean;
}

/** What the focused field of `details` is. Anything the engine cannot make sense of gets no menu. */
export async function analyzeFocus(details: CollectedPageDetails): Promise<{ kind?: FieldKind; signup: boolean }> {
  const activeId = details.fields.find((f) => f.isActive)?.fieldId;
  if (activeId === undefined) return { signup: false };
  await engine();
  const result = JSON.parse(analyze_page(JSON.stringify(details))) as { fields: AnalyzedField[] };
  const field = result.fields.find((f) => f.fieldId === activeId);
  return { kind: field?.menu, signup: !!field?.signup };
}

export type FillRequest =
  | { mode: "login"; origin: string; username: string; password: string; totp?: string; onlyEmpty?: boolean; passwordOnly?: boolean; autosubmit?: boolean }
  | { mode: "form"; origin: string; values: Record<string, string> };

interface PlanOp {
  fieldId: number;
  source: string;
  format?: ValueFormat;
}

interface FillPlan {
  ops: PlanOp[];
  submit?: { kind: "click"; fieldId: number; fallbackFieldId: number } | { kind: "enter"; fieldId: number };
}

type Target = { frameIds: number[] } | { allFrames: true };

const callInPage = (name: keyof PageApi, arg: unknown) => {
  const page = (globalThis as { plugwarden?: Record<string, (a: unknown) => unknown> }).plugwarden;
  return page ? { value: page[name]!(arg) } : "missing";
};

/**
 * Calls page.js in the target frames. A page opened before the extension was installed or updated does
 * not have it yet: it gets injected there, and the frames are asked again.
 */
export async function pageCall<T>(target: { tabId: number } & Target, name: keyof PageApi, arg: unknown): Promise<{ frameId: number; result: T }[]> {
  const call = () => chrome.scripting.executeScript({ target, func: callInPage, args: [name, arg ?? null] });
  let res = await call();
  if (res.some((r) => r.result === "missing")) {
    await chrome.scripting.executeScript({ target, files: ["page.js"] });
    res = await call();
  }
  return res.flatMap((r) => (r.result && r.result !== "missing" ? [{ frameId: r.frameId, result: (r.result as { value: T }).value }] : []));
}

const isResult = (v: unknown): v is FillResult => typeof (v as FillResult | null)?.filled === "boolean";

function valueOf(req: FillRequest, source: string): string {
  if (req.mode === "form") return req.values[source] ?? "";
  if (source === "username") return req.username;
  if (source === "password") return req.password;
  return source === "totp" ? (req.totp ?? "") : "";
}

function intentOf(req: FillRequest): unknown {
  if (req.mode === "form") return { kind: "form", keys: Object.keys(req.values).filter((k) => req.values[k]) };
  const { onlyEmpty = false, passwordOnly = false, autosubmit = false } = req;
  return { kind: "login", onlyEmpty, passwordOnly, hasTotp: !!req.totp, autosubmit };
}

/**
 * Collect, plan and fill in the target frames, top frame first in the answer. A frame on another origin
 * is refused before it reads a field, and again before it is written to.
 */
export async function fillInFrames(tabId: number, target: Target, req: FillRequest): Promise<{ frameId: number; result: FillResult }[]> {
  const collected = await pageCall<CollectedPageDetails | FillResult>({ tabId, ...target }, "collect", { origin: req.origin, mode: "FullPage" });
  await engine();
  const plans = collected.map(({ frameId, result }): { frameId: number; refused?: FillResult; plan?: FillPlan } => {
    if (isResult(result)) return { frameId, refused: result };
    try {
      return { frameId, plan: JSON.parse(plan(JSON.stringify({ details: parsePageDetails(result), intent: intentOf(req) }))) as FillPlan };
    } catch (e) {
      console.warn("autofill plan", e);
      return { frameId, refused: { filled: false, reason: "error" } };
    }
  });
  // A submit nobody looked at goes to one form at most.
  const planned = plans.filter((p) => p.plan?.ops.length).length;
  return Promise.all(
    plans.map(async ({ frameId, refused, plan: p }) => {
      if (refused) return { frameId, result: refused };
      if (!p?.ops.length) return { frameId, result: { filled: false, reason: "noFields" } satisfies FillResult };
      const execute: ExecuteFill = {
        origin: req.origin,
        ops: p.ops.flatMap((op) => {
          const value = valueOf(req, op.source);
          return value ? [{ fieldId: op.fieldId, value, format: op.format }] : [];
        }),
        onlyEmpty: req.mode === "login" && req.onlyEmpty,
        submit: planned === 1 ? p.submit : undefined,
      };
      const [res] = await pageCall<FillResult>({ tabId, frameIds: [frameId] }, "execute", execute);
      return { frameId, result: res?.result ?? { filled: false } };
    }),
  );
}
