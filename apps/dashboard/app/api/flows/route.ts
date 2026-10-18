import { listFlows } from "@frictionswarm/store";
import { json, touchOrchestrator } from "@/lib/api";
import { runStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Seed flows overlaid with the custom flows in the run store. */
export async function GET() {
  touchOrchestrator();
  return json(await listFlows(runStore()));
}
