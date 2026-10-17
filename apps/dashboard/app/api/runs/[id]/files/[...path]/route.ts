import { readFile } from "node:fs/promises";
import { type NextRequest } from "next/server";
import { resolveRunFile } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** Serves images (screenshots) from inside a run folder. Path traversal is refused in resolveRunFile. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/files/[...path]">) {
  const { id, path } = await ctx.params;
  const file = await resolveRunFile(id, path);
  if (!file) return new Response("Not found", { status: 404 });
  const body = await readFile(/*turbopackIgnore: true*/ file.path);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "private, max-age=5",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
