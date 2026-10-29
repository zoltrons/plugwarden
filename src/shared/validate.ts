// Tiny runtime validators. No dependencies; tolerant of unknown fields and, via `ci`, of key casing
// (Vaultwarden returns PascalCase from /identity and camelCase from /api).

export class ValidationError extends Error {
  override name = "ValidationError";
}

export type Validator<T> = (v: unknown, path: string) => T;

const fail = (path: string, want: string, v: unknown): never => {
  throw new ValidationError(`${path || "value"}: expected ${want}, got ${v === null ? "null" : typeof v}`);
};

export const str: Validator<string> = (v, p) => (typeof v === "string" ? v : fail(p, "string", v));
export const num: Validator<number> = (v, p) => (typeof v === "number" && Number.isFinite(v) ? v : fail(p, "number", v));
export const bool: Validator<boolean> = (v, p) => (typeof v === "boolean" ? v : fail(p, "boolean", v));
export const unknownValue: Validator<unknown> = (v) => v;
/** Plain JSON object with unvalidated contents (checked further by its consumer). */
export const record: Validator<Record<string, unknown>> = (v, p) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(p, "object", v);

export const opt =
  <T>(inner: Validator<T>): Validator<T | undefined> =>
  (v, p) =>
    v === undefined || v === null ? undefined : inner(v, p);

export const arr =
  <T>(inner: Validator<T>): Validator<T[]> =>
  (v, p) =>
    Array.isArray(v) ? v.map((x, i) => inner(x, `${p}[${i}]`)) : fail(p, "array", v);

export const literal =
  <const T extends readonly (string | number)[]>(...values: T): Validator<T[number]> =>
  (v, p) =>
    values.includes(v as T[number]) ? (v as T[number]) : fail(p, values.join("|"), v);

/** Case-insensitive own-property lookup. */
export function ci(o: unknown, key: string): unknown {
  if (!o || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  if (key in rec) return rec[key];
  const k = key.toLowerCase();
  for (const name of Object.keys(rec)) if (name.toLowerCase() === k) return rec[name];
  return undefined;
}

type Shape = Record<string, Validator<unknown>>;
type Out<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

/** Object validator. Keys are matched case-insensitively; unknown keys are ignored. */
export const obj =
  <S extends Shape>(shape: S): Validator<Out<S>> =>
  (v, p) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(p, "object", v);
    const out = {} as Record<string, unknown>;
    for (const [k, val] of Object.entries(shape)) out[k] = val(ci(v, k), p ? `${p}.${k}` : k);
    return out as Out<S>;
  };

export const parse = <T>(validator: Validator<T>, v: unknown): T => validator(v, "");
