import { type NextRequest } from "next/server";
import { errorJson, json, readBody, touchOrchestrator } from "@/lib/api";
import { requestFix } from "@/lib/control";

export const dynamic = "force-dynamic";

/** Asks for a fix of a finished analysis. Body (optional): { findingIds?: string[], seedsPerPersona?: number }. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/runs/[id]/fix">) {
  touchOrchestrator();
  const { id } = await ctx.params;
  const read = await readBody(req, true);
  if (!read.ok) return read.res;
  const r = await requestFix(id, read.body);
  return r.ok ? json(r.value, 202) : errorJson(r.status, r.error);
}
