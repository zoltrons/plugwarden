// Server capability detection via /api/config (vaultwarden src/api/core/mod.rs).
import { obj, opt, parse, str } from "../shared/validate.ts";
import { call } from "./http.ts";

const configResponse = obj({ version: str, server: opt(obj({ name: opt(str) })) });

export interface ServerInfo {
  /** Bitwarden-server compatibility level, e.g. "2026.6.0" on Vaultwarden 1.37.4. */
  version: string;
  name: string;
}

export async function getServerInfo(base: string): Promise<ServerInfo> {
  const c = parse(configResponse, await call(base, "GET", "/api/config"));
  return { version: c.version, name: c.server?.name ?? "Bitwarden" };
}
