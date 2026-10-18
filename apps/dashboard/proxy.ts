// Password gate (Next 16 "proxy", formerly middleware.ts). See lib/auth.ts.
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, gate } from "./lib/auth";

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const decision = await gate(path, req.cookies.get(AUTH_COOKIE)?.value, process.env, req.headers.get("authorization") ?? undefined);
  if (decision === "allow") return NextResponse.next();
  if (decision === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = path === "/" ? "" : `?next=${encodeURIComponent(path + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except static build assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
