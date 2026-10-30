// "Have I Been Pwned" password check with k-anonymity: only the first 5 hex digits of the SHA-1 leave
// the device, and the response is padded so its size does not reveal the match either.
const API = "https://api.pwnedpasswords.com/range/";

/** How many times `suffix` appears in a range response (lines of `SUFFIX:COUNT`); padding rows count 0. */
export function countInRange(body: string, suffix: string): number {
  for (const line of body.split(/\r?\n/)) {
    const [s, n] = line.split(":");
    if (s?.trim().toUpperCase() === suffix) return Number(n) || 0;
  }
  return 0;
}

export async function pwnedCount(password: string): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const res = await fetch(API + hex.slice(0, 5), { headers: { "Add-Padding": "true" }, credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return countInRange(await res.text(), hex.slice(5));
}
