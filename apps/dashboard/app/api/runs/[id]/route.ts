import { NextResponse, type NextRequest } from "next/server";
import { getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** Run detail. `?events=1` also returns the raw event log (used by Replay). */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  const run = await getRun(id, { events: req.nextUrl.searchParams.get("events") === "1" });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
}
