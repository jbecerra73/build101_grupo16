import { type NextRequest } from "next/server";
import { errorJson, json, touchOrchestrator } from "@/lib/api";
import { getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** Run detail. `?events=1` also returns the raw event log (used by Replay). */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/runs/[id]">) {
  touchOrchestrator();
  const { id } = await ctx.params;
  const run = await getRun(id, { events: req.nextUrl.searchParams.get("events") === "1" });
  if (!run) return errorJson(404, "Run not found");
  return json(run);
}
