import { actionBudget, PERSONAS, type Event, type Flow, type Persona } from "@frictionswarm/shared";

export type Validity = { valid: boolean; reasons: string[] };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Last value typed into each known form field. */
export function typedFields(events: Event[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events)
    if (e.type === "action" && e.action?.kind === "type" && e.action.field) m.set(e.action.field, e.action.text ?? "");
  return m;
}

/** The agent's seeded action budget (actionBudget), or undefined for an unknown persona. */
export function agentBudget(events: Event[], personas: Record<string, Persona> = PERSONAS): number | undefined {
  const first = events[0];
  const persona = first && personas[first.personaId];
  return persona ? actionBudget(persona, first.seed) : undefined;
}

/** SPEC completion validity: success AND required steps AND required fields AND confirmation echo,
 * AND no more actions than the agent's seeded budget. */
export function validateCompletion(flow: Flow, events: Event[], personas: Record<string, Persona> = PERSONAS): Validity {
  const reasons: string[] = [];
  const success = events.findLast((e) => e.type === "success");
  if (!success) reasons.push("no success event");

  const budget = agentBudget(events, personas);
  if (budget !== undefined && events.filter((e) => e.type === "action").length > budget) reasons.push("exceeded action budget");

  const seen = new Set(events.map((e) => e.step).filter(Boolean));
  const missingSteps = flow.required.steps.filter((s) => !seen.has(s));
  if (missingSteps.length) reasons.push(`skipped required step(s): ${missingSteps.join(", ")}`);

  const typed = typedFields(events);
  const missingFields = flow.required.fields.filter((f) => !typed.get(f)?.trim());
  if (missingFields.length) reasons.push(`required field(s) not filled: ${missingFields.join(", ")}`);

  if (success) {
    const c = success.confirmation ?? {};
    const req = new Set<string>(flow.required.fields);
    const email = typed.get("email");
    if (req.has("email") && email && norm(c.email ?? "") !== norm(email))
      reasons.push(`confirmation email "${c.email ?? ""}" does not echo typed "${email}"`);
    const address = typed.get("address");
    if (req.has("address") && address && !norm(c.address ?? "").includes(norm(address)))
      reasons.push(`confirmation address "${c.address ?? ""}" does not echo typed "${address}"`);
    const card = typed.get("cardNumber")?.replace(/\D/g, "");
    if (req.has("cardNumber") && card && (c.cardLast4 ?? "") !== card.slice(-4))
      reasons.push(`confirmation card last 4 "${c.cardLast4 ?? ""}" does not match typed "${card.slice(-4)}"`);
  }
  return { valid: reasons.length === 0, reasons };
}
