/** Normalizes a user-entered server URL to origin + path, without trailing slash. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Server URL must start with https://");
  if (u.username || u.password || u.search || u.hash)
    throw new Error("Server URL must not contain credentials, a query or a fragment");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** chrome.permissions origin pattern for the server. */
export const originPattern = (serverUrl: string): string => `${new URL(serverUrl).origin}/*`;
