// Minimal OpenID Connect provider for the SSO e2e test. Test-only, no dependencies.
// It signs in whoever the test names: POST /_next {"email": "..."} sets the identity for the next
// /authorize, which redirects straight back with a code (no login page).
// Runs in Vaultwarden's network namespace (docker-compose.yml), so http://localhost:9090 is the same
// issuer for the server and for the browser.
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = 9090;
const ISSUER = `http://localhost:${PORT}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
const codes = new Map(); // code -> { email, nonce, clientId }
let nextEmail = "sso-user@example.test";

const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(claims) {
  const data = `${b64u({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64u(claims)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url")}`;
}
const sub = (email) => `sub-${Buffer.from(email).toString("hex")}`;

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  let body = "";
  for await (const chunk of req) body += chunk;
  switch (url.pathname) {
    case "/.well-known/openid-configuration":
      return json(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "email", "profile"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    case "/jwks":
      return json(res, 200, { keys: [jwk] });
    case "/_next":
      nextEmail = JSON.parse(body).email;
      return json(res, 200, { ok: true });
    case "/authorize": {
      const code = randomBytes(16).toString("hex");
      codes.set(code, { email: nextEmail, nonce: url.searchParams.get("nonce"), clientId: url.searchParams.get("client_id") });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    case "/token": {
      const form = new URLSearchParams(body);
      const c = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      if (!c) return json(res, 400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: ISSUER, sub: sub(c.email), aud: c.clientId, iat: now, exp: now + 300, email: c.email, email_verified: true, ...(c.nonce ? { nonce: c.nonce } : {}) };
      return json(res, 200, { access_token: jwt({ ...claims, aud: ISSUER }), token_type: "Bearer", expires_in: 300, id_token: jwt(claims) });
    }
    case "/userinfo": {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}");
      return json(res, 200, { sub: claims.sub, email: claims.email, email_verified: true });
    }
    default:
      return json(res, 404, { error: "not_found" });
  }
}).listen(PORT, () => console.log(`mock IdP on ${ISSUER}`));
