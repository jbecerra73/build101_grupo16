import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ensureInlineOrchestrator, RunCapError } from "./orchestrator";

export const NO_STORE = { "Cache-Control": "no-store" };

/** JSON response that is never cached (everything here is live state). */
export const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: NO_STORE });

export const errorJson = (status: number, error: string, errors?: string[]) => json({ error, errors: errors ?? [error] }, status);

/** Parses a JSON body; `undefined` body (empty) is allowed when `optional`. */
export async function readBody(req: NextRequest, optional = false): Promise<{ ok: true; body: unknown } | { ok: false; res: NextResponse }> {
  const text = await req.text();
  if (!text.trim() && optional) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, res: errorJson(400, "Body must be valid JSON") };
  }
}

/** Every API route calls this: in inline mode it boots the in-process orchestrator. */
export function touchOrchestrator() {
  void ensureInlineOrchestrator();
}

export function capOrError(err: unknown) {
  if (err instanceof RunCapError) return errorJson(429, err.message);
  return errorJson(500, err instanceof Error ? err.message : "Request failed");
}
