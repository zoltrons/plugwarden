/**
 * Loopback hosts. Plain http is tolerated for a server on this machine only (development); every
 * other host must use https, or the master password hash, the tokens and the vault travel in clear.
 */
export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** Normalizes a user-entered server URL to origin + path, without trailing slash. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname)))
    throw new Error("Server URL must start with https:// (plain http is only allowed for localhost)");
  if (u.username || u.password || u.search || u.hash)
    throw new Error("Server URL must not contain credentials, a query or a fragment");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** chrome.permissions origin pattern for the server. */
export const originPattern = (serverUrl: string): string => `${new URL(serverUrl).origin}/*`;
