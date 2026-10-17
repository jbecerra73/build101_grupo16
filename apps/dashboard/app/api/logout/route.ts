import { json } from "@/lib/api";
import { AUTH_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
