import { NextResponse, type NextRequest } from "next/server";
import { startPipeline } from "@/lib/orchestrator";
import { listRuns } from "@/lib/runs";
import { parseStartRunRequest } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listRuns());
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errors: ["Body must be valid JSON"] }, { status: 400 });
  }
  const parsed = parseStartRunRequest(body);
  if (!parsed.ok) return NextResponse.json({ errors: parsed.errors }, { status: 400 });
  try {
    const { runId } = await startPipeline(parsed.value);
    return NextResponse.json({ runId }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ errors: [err instanceof Error ? err.message : "Failed to start run"] }, { status: 500 });
  }
}
