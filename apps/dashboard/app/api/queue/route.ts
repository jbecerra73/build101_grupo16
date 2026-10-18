import { errorJson, json, touchOrchestrator } from "@/lib/api";
import { clearQueue } from "@/lib/control";

export const dynamic = "force-dynamic";

/** Cancels every queued run; running ones are untouched. */
export async function DELETE() {
  touchOrchestrator();
  try {
    return json(await clearQueue("Queue cleared from the control center"));
  } catch (e) {
    return errorJson(500, e instanceof Error ? e.message : "Clearing the queue failed");
  }
}
