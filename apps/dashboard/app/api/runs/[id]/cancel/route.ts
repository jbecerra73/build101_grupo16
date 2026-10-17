import { type NextRequest } from "next/server";
import { errorJson, json, readBody, touchOrchestrator } from "@/lib/api";
import { cancelRun } from "@/lib/control";

export const dynamic = "force-dynamic";

/** Cancels a queued or running run. Body (optional): { reason?: string }. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/runs/[id]/cancel">) {
  touchOrchestrator();
  const { id } = await ctx.params;
  const read = await readBody(req, true);
  if (!read.ok) return read.res;
  const b = read.body as { reason?: unknown } | undefined;
  const reason = typeof b?.reason === "string" ? b.reason.slice(0, 200) : undefined;
  const r = await cancelRun(id, reason);
  return r.ok ? json(r.value) : errorJson(r.status, r.error);
}
