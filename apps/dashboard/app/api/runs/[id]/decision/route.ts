import { type NextRequest } from "next/server";
import { errorJson, json, readBody, touchOrchestrator } from "@/lib/api";
import { requestDecision } from "@/lib/control";

export const dynamic = "force-dynamic";

/** Accepts or rejects the fix of a run awaiting a decision. Body: { decision: "accept" | "reject", reason?: string, override?: boolean }. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/runs/[id]/decision">) {
  touchOrchestrator();
  const { id } = await ctx.params;
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const r = await requestDecision(id, read.body);
  return r.ok ? json(r.value, 202) : errorJson(r.status, r.error);
}
