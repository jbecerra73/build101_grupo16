import { type NextRequest } from "next/server";
import { readRunFile } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** Serves images (screenshots) from a run folder in the run store. Path
 * traversal is refused in runFileKey. A run's screenshot never changes once
 * written (new runs get new ids), so the browser may keep it; misses are not
 * cached because the orchestrator may still be uploading it. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/files/[...path]">) {
  const { id, path } = await ctx.params;
  const file = await readRunFile(id, path);
  if (!file) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(new Uint8Array(file.body), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.body.byteLength),
      // private: the dashboard sits behind a password cookie.
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
