import { type NextRequest } from "next/server";
import { errorJson, json, touchOrchestrator } from "@/lib/api";
import { getSwarm } from "@/lib/control";

export const dynamic = "force-dynamic";

/** SwarmTopology (swarm.json) of a run, 404 until the swarm runner writes it. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/swarm">) {
  touchOrchestrator();
  const { id } = await ctx.params;
  const topo = await getSwarm(id).catch(() => undefined);
  if (!topo) return errorJson(404, "No swarm topology for this run");
  return json(topo);
}
