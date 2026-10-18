// Password gate for the deployed dashboard (Netlify's own password protection
// is a paid feature). With DASHBOARD_PASSWORD unset the gate is off (local dev).
// The cookie is "<expiry>.<hmac>": HMAC-SHA256 over the expiry, keyed with
// AUTH_SECRET (or the password itself), so it cannot be forged and changing the
// password or secret logs everyone out. Web Crypto only: runs in proxy.ts too.

export const AUTH_COOKIE = "fs_auth";
export const AUTH_MAX_AGE_S = 7 * 24 * 3600;

type Env = Record<string, string | undefined>;

export const authEnabled = (env: Env = process.env) => !!env.DASHBOARD_PASSWORD;

const secretOf = (env: Env) => env.AUTH_SECRET || env.DASHBOARD_PASSWORD || "";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function signSession(env: Env = process.env, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const exp = nowS + AUTH_MAX_AGE_S;
  return `${exp}.${await hmacHex(secretOf(env), `frictionswarm:${exp}`)}`;
}

export async function verifySession(cookie: string | undefined, env: Env = process.env, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!cookie || !authEnabled(env)) return false;
  const [expRaw, sig, ...rest] = cookie.split(".");
  if (rest.length || !expRaw || !sig || !/^\d+$/.test(expRaw)) return false;
  if (Number(expRaw) < nowS) return false;
  return safeEqual(sig, await hmacHex(secretOf(env), `frictionswarm:${expRaw}`));
}

export async function checkPassword(password: unknown, env: Env = process.env): Promise<boolean> {
  if (!authEnabled(env) || typeof password !== "string") return false;
  // Compare digests so the comparison does not depend on the password length.
  const [a, b] = await Promise.all([hmacHex("pw", password), hmacHex("pw", env.DASHBOARD_PASSWORD!)]);
  return safeEqual(a, b);
}

/** Paths reachable without the cookie. */
export const isPublicPath = (path: string) =>
  path === "/login" || path === "/api/login" || path === "/api/logout" || path.startsWith("/_next/") || path === "/favicon.ico";

export type GateDecision = "allow" | "unauthorized" | "login";

/** What proxy.ts does with a request. A bearer DASHBOARD_API_TOKEN (for the MCP
 * server) opens /api/* only; pages still need the cookie. */
export async function gate(path: string, cookie: string | undefined, env: Env = process.env, authorization?: string): Promise<GateDecision> {
  if (!authEnabled(env) || isPublicPath(path)) return "allow";
  if (await verifySession(cookie, env)) return "allow";
  const token = env.DASHBOARD_API_TOKEN;
  if (token && path.startsWith("/api/") && authorization !== undefined && safeEqual(authorization, `Bearer ${token}`)) return "allow";
  return path.startsWith("/api/") ? "unauthorized" : "login";
}
