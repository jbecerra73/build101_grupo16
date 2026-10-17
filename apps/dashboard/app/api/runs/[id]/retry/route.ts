import { type NextRequest } from "next/server";
import { capOrError, errorJson, json } from "@/lib/api";
import { retryRun } from "@/lib/control";

export const dynamic = "force-dynamic";

/** Queues the run's request again (fresh seeds). Returns { runId } of the new run. */
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/retry">) {
  const { id } = await ctx.params;
  try {
    const r = await retryRun(id);
    return r.ok ? json(r.value, 201) : errorJson(r.status, r.error);
  } catch (err) {
    return capOrError(err);
  }
}
