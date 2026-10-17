import { type NextRequest } from "next/server";
import { errorJson, json, readBody } from "@/lib/api";
import { AUTH_COOKIE, AUTH_MAX_AGE_S, authEnabled, checkPassword, signSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** { password } -> sets the session cookie. */
export async function POST(req: NextRequest) {
  if (!authEnabled()) return json({ ok: true, disabled: true });
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const password = (read.body as { password?: unknown } | undefined)?.password;
  if (!(await checkPassword(password))) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    return errorJson(401, "Wrong password");
  }
  const res = json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await signSession(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: AUTH_MAX_AGE_S,
  });
  return res;
}
