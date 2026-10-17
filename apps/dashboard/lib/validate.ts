import { FLOWS, PERSONAS, type StartRunRequest } from "@frictionswarm/shared";

export const MAX_SEEDS_PER_PERSONA = 10;

/** Validates an untrusted body as a StartRunRequest. Returns the cleaned request or a list of errors. */
export function parseStartRunRequest(body: unknown): { ok: true; value: StartRunRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be a JSON object"] };
  const b = body as Record<string, unknown>;

  if (typeof b.flowId !== "string" || !FLOWS[b.flowId]) errors.push(`flowId must be one of: ${Object.keys(FLOWS).join(", ")}`);

  const personaIds = Array.isArray(b.personaIds) ? b.personaIds : undefined;
  if (!personaIds || personaIds.length === 0) errors.push("personaIds must be a non-empty array");
  else {
    if (personaIds.some((p) => typeof p !== "string" || !PERSONAS[p])) errors.push(`personaIds must be from: ${Object.keys(PERSONAS).join(", ")}`);
    if (new Set(personaIds).size !== personaIds.length) errors.push("personaIds must not repeat");
  }

  const seeds = b.seedsPerPersona;
  if (typeof seeds !== "number" || !Number.isInteger(seeds) || seeds < 1 || seeds > MAX_SEEDS_PER_PERSONA)
    errors.push(`seedsPerPersona must be an integer from 1 to ${MAX_SEEDS_PER_PERSONA}`);

  if (typeof b.autoFix !== "boolean") errors.push("autoFix must be a boolean");

  let targetUrl: string | undefined;
  if (b.targetUrl !== undefined && b.targetUrl !== null && b.targetUrl !== "") {
    try {
      if (typeof b.targetUrl !== "string") throw new Error();
      const u = new URL(b.targetUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      targetUrl = u.toString();
    } catch {
      errors.push("targetUrl must be an http(s) URL");
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      flowId: b.flowId as string,
      personaIds: personaIds as string[],
      seedsPerPersona: seeds as number,
      autoFix: b.autoFix as boolean,
      ...(targetUrl ? { targetUrl } : {}),
    },
  };
}
