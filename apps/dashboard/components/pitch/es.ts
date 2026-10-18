import type { SegmentId } from "@frictionswarm/shared";
import { personaShort } from "@/lib/format";

/** Spanish labels for the pitch. Established English terms (PR, swarm, persona, agents,
 * findings, checkout, release, completion, Mobile/Desktop…) stay in English on purpose. */

const SEGMENT_ES: Record<SegmentId, string> = { low_vision: "Baja visión", mobile: "Mobile", desktop: "Desktop" };
export const segmentEs = (id: string) => SEGMENT_ES[id as SegmentId] ?? id;

const PERSONA_ES: Record<string, string> = { typical: "Comprador típico" };
export const personaEs = (id: string) => PERSONA_ES[id] ?? personaShort(id);

/** "9 sept" (UTC, so a YYYY-MM-DD never shifts a day). */
export const shortDateEs = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("es", { month: "short", day: "numeric", timeZone: "UTC" });

export const monthEs = (ms: number) => new Date(ms).toLocaleDateString("es", { month: "short", timeZone: "UTC" });
