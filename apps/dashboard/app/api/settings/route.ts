import { type NextRequest } from "next/server";
import { errorJson, json, readBody, touchOrchestrator } from "@/lib/api";
import { getSettings, updateSettings } from "@/lib/control";

export const dynamic = "force-dynamic";

export async function GET() {
  touchOrchestrator();
  return json(await getSettings());
}

/** Validated (partial) update; returns the full Settings. */
export async function PUT(req: NextRequest) {
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const r = await updateSettings(read.body);
  return r.ok ? json(r.value) : errorJson(400, r.errors.join("; "), r.errors);
}
