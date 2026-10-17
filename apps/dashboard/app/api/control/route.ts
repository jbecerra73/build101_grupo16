import { json, touchOrchestrator } from "@/lib/api";
import { getControlOverview } from "@/lib/control";

export const dynamic = "force-dynamic";

/** ControlOverview: active/recent/queued runs, usage, settings, orchestrator heartbeat. */
export async function GET() {
  touchOrchestrator();
  return json(await getControlOverview());
}
