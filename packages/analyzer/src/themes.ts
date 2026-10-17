import { z } from "zod";
import type { Event, Finding, PersonaId } from "@frictionswarm/shared";
import { groupByAgent } from "./run";

/** Why agents gave up, grouped into a theme with verbatim persona quotes.
 * Written to runs/<runId>/themes.json as Theme[] (largest theme first). */
export type Theme = {
  /** T1..Tn */
  id: string;
  title: string;
  personas: PersonaId[];
  /** Distinct agents whose give-up belongs to this theme. */
  agentCount: number;
  /** Copied verbatim from that agent's notes (give_up / think_aloud). */
  quotes: { personaId: PersonaId; agentId: string; text: string }[];
  /** Findings that describe the same problem. */
  findingIds?: string[];
};

/** What the model returns for themes (in the same answer as the findings). */
export const ModelThemeSchema = z.object({
  title: z.string(),
  agentIds: z.array(z.string()),
  quotes: z.array(z.object({ agentId: z.string(), text: z.string() })),
  findingIds: z.array(z.string()),
});
export type ModelTheme = z.infer<typeof ModelThemeSchema>;

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Agents that gave up: agentId → { personaId, step, notes }. */
export function giveUpAgents(events: Event[]) {
  const out = new Map<string, { personaId: PersonaId; step: string; reason?: string; notes: string[] }>();
  for (const [agentId, evs] of groupByAgent(events)) {
    const g = evs.findLast((e) => e.type === "give_up");
    if (!g) continue;
    out.set(agentId, {
      personaId: g.personaId,
      step: g.step ?? evs.findLast((e) => e.step)?.step ?? "Unknown step",
      reason: g.note?.trim() || undefined,
      notes: evs.map((e) => e.note?.trim()).filter((n): n is string => !!n),
    });
  }
  return out;
}

const finish = (themes: Omit<Theme, "id">[]): Theme[] =>
  themes
    .toSorted((a, b) => b.agentCount - a.agentCount)
    .map((t, i) => ({ id: `T${i + 1}`, ...t }));

/** Validate model themes: only agents that gave up, quotes copied from that agent's notes,
 * personas derived from the agents (never trusted from the model), finding ids mapped
 * through `findingIdMap` (model's position-based id → final id). */
export function sanitizeThemes(raw: ModelTheme[], events: Event[], findingIdMap: Map<string, string>): Theme[] {
  const gave = giveUpAgents(events);
  const themes = raw.flatMap((t): Omit<Theme, "id">[] => {
    const quotes = uniq(
      t.quotes
        .map((q) => ({ agentId: q.agentId, text: q.text.trim() }))
        .filter((q) => q.text && gave.get(q.agentId)?.notes.some((n) => n.includes(q.text)))
        .map((q) => JSON.stringify([q.agentId, q.text])),
    ).map((k) => {
      const [agentId, text] = JSON.parse(k) as [string, string];
      return { personaId: gave.get(agentId)!.personaId, agentId, text };
    });
    const agents = uniq([...t.agentIds.filter((a) => gave.has(a)), ...quotes.map((q) => q.agentId)]);
    if (!agents.length || !t.title.trim()) return [];
    const findingIds = uniq(t.findingIds.map((f) => findingIdMap.get(f)).filter((f): f is string => !!f));
    return [
      {
        title: t.title.trim(),
        personas: uniq(agents.map((a) => gave.get(a)!.personaId)),
        agentCount: agents.length,
        quotes,
        ...(findingIds.length ? { findingIds } : {}),
      },
    ];
  });
  return finish(themes);
}

/** Deterministic themes: one per step where agents gave up, quoting each give-up reason,
 * linked to the findings at that step that cover the same personas. */
export function heuristicThemes(events: Event[], findings: Finding[] = []): Theme[] {
  const byStep = new Map<string, { agentId: string; personaId: PersonaId; reason?: string }[]>();
  for (const [agentId, a] of giveUpAgents(events)) byStep.set(a.step, [...(byStep.get(a.step) ?? []), { agentId, ...a }]);
  return finish(
    [...byStep].map(([step, agents]) => {
      const personas = uniq(agents.map((a) => a.personaId));
      const findingIds = findings.filter((f) => f.step === step && f.personas.some((p) => personas.includes(p))).map((f) => f.id);
      return {
        title: `Gave up at ${step}`,
        personas,
        agentCount: agents.length,
        quotes: agents.flatMap(({ agentId, personaId, reason }) => (reason ? [{ personaId, agentId, text: reason }] : [])),
        ...(findingIds.length ? { findingIds } : {}),
      };
    }),
  );
}
