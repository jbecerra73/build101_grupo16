import { PERSONAS, SEGMENTS } from "@frictionswarm/shared";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

/** The personas a flow can be tested with, and the PostHog segment each one stands for. */
export async function GET() {
  return json(
    Object.values(PERSONAS).map((p) => ({
      id: p.id,
      name: p.name,
      oneLiner: p.prompt.split(/(?<=[.!?])\s/)[0],
      segmentId: SEGMENTS.find((s) => s.personaId === p.id)?.id,
      control: !!p.control,
    })),
  );
}
