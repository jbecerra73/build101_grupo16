// Password gate (Next 16 "proxy", formerly middleware.ts). See lib/auth.ts.
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, gate } from "./lib/auth";

/** Served for every request when this deploy requires a password but has none (fail closed). */
const SETUP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FrictionSwarm: set DASHBOARD_PASSWORD</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}code{background:#222}}</style></head>
<body><h1>Set DASHBOARD_PASSWORD</h1>
<p>This FrictionSwarm dashboard is deployed without a password, so it serves nothing.</p>
<p>In the Netlify UI open <b>Project configuration &rarr; Environment variables</b>, add <code>DASHBOARD_PASSWORD</code>
(scope: Functions, all deploy contexts), then trigger a redeploy. See <code>docs/DEPLOY.md</code>.</p></body></html>`;

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const decision = await gate(path, req.cookies.get(AUTH_COOKIE)?.value, process.env, req.headers.get("authorization") ?? undefined);
  if (decision === "allow") return NextResponse.next();
  if (decision === "setup")
    return path.startsWith("/api/")
      ? NextResponse.json({ error: "DASHBOARD_PASSWORD is not set on this deploy" }, { status: 503 })
      : new NextResponse(SETUP_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
