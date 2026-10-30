// Small helpers for the item view's website rows.
import { isLoopback } from "./url.ts";

const parse = (u: string): URL | undefined => {
  try {
    return new URL(u);
  } catch {
    return undefined;
  }
};

/** `http://` to a host that is not this machine: the page and what the user types travel in clear. */
export const isInsecureUri = (u: string): boolean => {
  const url = parse(u);
  return !!url && url.protocol === "http:" && !isLoopback(url.hostname);
};

/** The same address over https, or undefined when it is not an insecure http URI. */
export const toHttps = (u: string): string | undefined => {
  const url = isInsecureUri(u) ? parse(u) : undefined;
  if (!url) return undefined;
  url.protocol = "https:";
  return url.toString();
};

/** The site's front page when `u` points deeper into it, otherwise undefined. */
export const mainPage = (u: string): string | undefined => {
  const url = parse(u);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  return url.pathname.replace(/\/+$/, "") || url.search || url.hash ? `${url.origin}/` : undefined;
};
