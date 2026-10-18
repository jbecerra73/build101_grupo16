import { type NextRequest } from "next/server";
import { diffFlows, flowHash, getFlow, validateFlow } from "@frictionswarm/store";
import { json, readBody, touchOrchestrator } from "@/lib/api";
import { runStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Dry-run for a flow draft: validates it and shows what changes against the saved flow (or `baseFlowId`).
 * Body: { flow, baseFlowId? }. Nothing is saved; PUT /api/flows/:id with the returned draftHash saves it. */
export async function POST(req: NextRequest) {
  touchOrchestrator();
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const b = (read.body && typeof read.body === "object" ? read.body : {}) as { flow?: unknown; baseFlowId?: unknown };
  const v = validateFlow(b.flow);
  if (!v.ok) return json({ ok: false, missing: v.missing, errors: v.errors });
  const store = runStore();
  const existing = await getFlow(store, v.flow.id);
  const base = typeof b.baseFlowId === "string" ? await getFlow(store, b.baseFlowId) : existing;
  return json({ ok: true, flow: v.flow, draftHash: flowHash(v.flow), changes: diffFlows(base, v.flow), isNew: !existing });
}
