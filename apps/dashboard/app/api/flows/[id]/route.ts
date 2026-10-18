import { type NextRequest } from "next/server";
import { flowHash, getFlow, putFlow, validateFlow } from "@frictionswarm/store";
import { errorJson, json, readBody, touchOrchestrator } from "@/lib/api";
import { runStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/flows/[id]">) {
  touchOrchestrator();
  const { id } = await ctx.params;
  const flow = await getFlow(runStore(), id);
  return flow ? json(flow) : errorJson(404, "Flow not found");
}

/** Saves a flow that was reviewed through /api/flows/validate. Body: { flow, draftHash }. */
export async function PUT(req: NextRequest, ctx: RouteContext<"/api/flows/[id]">) {
  touchOrchestrator();
  const { id } = await ctx.params;
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const b = (read.body && typeof read.body === "object" ? read.body : {}) as { flow?: unknown; draftHash?: unknown };
  const v = validateFlow(b.flow);
  if (!v.ok) return errorJson(400, "Invalid flow", [...v.missing.map((m) => `Missing ${m}`), ...v.errors]);
  if (v.flow.id !== id) return errorJson(400, `flow.id "${v.flow.id}" must match the URL id "${id}"`);
  if (typeof b.draftHash !== "string" || flowHash(v.flow) !== b.draftHash) return errorJson(409, "Flow changed since it was reviewed");
  await putFlow(runStore(), v.flow);
  return json({ flow: v.flow });
}
