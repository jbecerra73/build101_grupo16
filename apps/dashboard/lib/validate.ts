import { MAX_GOAL_LENGTH, type StartRunRequest } from "@frictionswarm/shared";
import { getFlow, listFlows } from "@frictionswarm/store";
import { runStore } from "./store";

export const MAX_SEEDS_PER_PERSONA = 10;

const DATE = /^\d{4}-\d\d-\d\d$/;
const validDate = (s: unknown): s is string => typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(s));

/** Validates an untrusted body as a StartRunRequest ("Analyze"). Returns the cleaned request or a list of errors. */
export async function parseStartRunRequest(body: unknown): Promise<{ ok: true; value: StartRunRequest } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be a JSON object"] };
  const b = body as Record<string, unknown>;

  const flow = typeof b.flowId === "string" ? await getFlow(runStore(), b.flowId) : undefined;
  if (!flow)
    errors.push(`flowId must be one of: ${(await listFlows(runStore())).map((f) => f.id).join(", ")}`);

  const goal = typeof b.goal === "string" ? b.goal.trim() : undefined;
  if (b.goal !== undefined && b.goal !== null && (goal === undefined || goal.length > MAX_GOAL_LENGTH))
    errors.push(`goal must be a string of at most ${MAX_GOAL_LENGTH} characters`);

  let window: StartRunRequest["window"];
  if (b.window !== undefined && b.window !== null) {
    const w = b.window as Record<string, unknown>;
    if (typeof w !== "object" || !validDate(w.from) || !validDate(w.to)) errors.push("window must be { from, to } with YYYY-MM-DD dates");
    else if (Date.parse(w.from) >= Date.parse(w.to)) errors.push("window.from must be before window.to");
    else window = { from: w.from, to: w.to };
  }

  if (b.source !== undefined && b.source !== "file" && b.source !== "api") errors.push("source must be file or api");

  const seeds = b.seedsPerPersona;
  if (seeds !== undefined && (typeof seeds !== "number" || !Number.isInteger(seeds) || seeds < 1 || seeds > MAX_SEEDS_PER_PERSONA))
    errors.push(`seedsPerPersona must be an integer from 1 to ${MAX_SEEDS_PER_PERSONA}`);

  if (typeof b.autoFix !== "boolean") errors.push("autoFix must be a boolean");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      flowId: b.flowId as string,
      // An empty goal or the preset's own means "use the flow's goal".
      ...(goal && goal !== flow!.goal ? { goal } : {}),
      ...(window ? { window } : {}),
      ...(b.source ? { source: b.source as "file" | "api" } : {}),
      ...(seeds !== undefined ? { seedsPerPersona: seeds as number } : {}),
      autoFix: b.autoFix as boolean,
    },
  };
}
