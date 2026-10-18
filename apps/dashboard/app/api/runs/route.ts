import { type NextRequest } from "next/server";
import { capOrError, errorJson, json, readBody, touchOrchestrator } from "@/lib/api";
import { enqueueRun } from "@/lib/orchestrator";
import { listRuns } from "@/lib/runs";
import { parseStartRunRequest } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET() {
  touchOrchestrator();
  return json(await listRuns());
}

/** Queues a run (QueuedRun in the run store) and returns its pre-assigned id. */
export async function POST(req: NextRequest) {
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const parsed = await parseStartRunRequest(read.body);
  if (!parsed.ok) return errorJson(400, parsed.errors.join("; "), parsed.errors);
  try {
    return json(await enqueueRun(parsed.value), 201);
  } catch (err) {
    return capOrError(err);
  }
}
