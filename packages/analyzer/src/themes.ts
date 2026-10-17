import { z } from "zod";
import { SEGMENTS, type Finding, type PersonaId, type RunKind, type SegmentId } from "@frictionswarm/shared";
import type { SessionSummary } from "./sessions";

/** Why sessions ended without an order, grouped into themes, largest first.
 * Written to runs/<runId>/themes.json as Theme[].
 *   retest:   swarm give-ups grouped by reason, with verbatim agent quotes (Sonnet, else one theme per give-up step)
 *   analysis: real users' exits grouped by step and linked to the findings there (no quotes) */
export type Theme = {
  /** T1..Tn */
  id: string;
  title: string;
  segments: SegmentId[];
  personas: PersonaId[];
  /** Sessions (real users) or agents (swarm) in this theme. */
  sessions: number;
  /** Copied verbatim from the agent's swarm_give_up / swarm_think_aloud notes; retest only. */
  quotes: { sessionId: string; agentId?: string; personaId?: PersonaId; text: string }[];
  /** Findings that describe the same problem. */
  findingIds?: string[];
};

/** What the model returns for themes (retest runs). */
export const ModelThemeSchema = z.object({
  title: z.string(),
  agentIds: z.array(z.string()),
  quotes: z.array(z.object({ agentId: z.string(), text: z.string() })),
  findingIds: z.array(z.string()),
});
export type ModelTheme = z.infer<typeof ModelThemeSchema>;

const uniq = <T>(xs: T[]) => [...new Set(xs)];

export type GiveUp = { sessionId: string; personaId: PersonaId; step: string; reason?: string; notes: string[] };

/** Swarm agents that gave up: agentId → where and why, with all their notes. */
export function giveUpAgents(sessions: SessionSummary[]): Map<string, GiveUp> {
  const out = new Map<string, GiveUp>();
  for (const s of sessions) {
    const g = s.notes.findLast((n) => n.kind === "give_up");
    if (!g || !s.agentId) continue;
    out.set(s.agentId, {
      sessionId: s.id,
      personaId: s.personaId ?? "unknown",
      step: g.step ?? s.lastStep ?? "Unknown step",
      reason: g.text || undefined,
      notes: s.notes.map((n) => n.text),
    });
  }
  return out;
}

const finish = (themes: Omit<Theme, "id">[]): Theme[] =>
  themes.toSorted((a, b) => b.sessions - a.sessions).map((t, i) => ({ id: `T${i + 1}`, ...t }));

const segmentsOfPersonas = (personas: string[]) =>
  SEGMENTS.filter((s) => personas.includes(s.personaId)).map((s) => s.id);

/** Validate model themes: only agents that gave up, quotes copied from that agent's notes,
 * personas derived from the agents, finding ids mapped through `findingIdMap`. */
export function sanitizeThemes(raw: ModelTheme[], sessions: SessionSummary[], findingIdMap: Map<string, string>): Theme[] {
  const gave = giveUpAgents(sessions);
  const themes = raw.flatMap((t): Omit<Theme, "id">[] => {
    const quotes = uniq(
      t.quotes
        .map((q) => ({ agentId: q.agentId, text: q.text.trim() }))
        .filter((q) => q.text && gave.get(q.agentId)?.notes.some((n) => n.includes(q.text)))
        .map((q) => JSON.stringify([q.agentId, q.text])),
    ).map((k) => {
      const [agentId, text] = JSON.parse(k) as [string, string];
      const g = gave.get(agentId)!;
      return { sessionId: g.sessionId, agentId, personaId: g.personaId, text };
    });
    const agents = uniq([...t.agentIds.filter((a) => gave.has(a)), ...quotes.map((q) => q.agentId)]);
    if (!agents.length || !t.title.trim()) return [];
    const personas = uniq(agents.map((a) => gave.get(a)!.personaId));
    const findingIds = uniq(t.findingIds.map((f) => findingIdMap.get(f)).filter((f): f is string => !!f));
    return [
      {
        title: t.title.trim(),
        segments: segmentsOfPersonas(personas),
        personas,
        sessions: agents.length,
        quotes,
        ...(findingIds.length ? { findingIds } : {}),
      },
    ];
  });
  return finish(themes);
}

/** Deterministic themes. Retest: one per step where agents gave up, quoting each reason.
 * Analysis: one per step where real users left (≥ 1% of sessions), titled by its top finding. */
export function heuristicThemes(kind: RunKind, sessions: SessionSummary[], findings: Finding[] = []): Theme[] {
  if (kind === "retest") {
    const byStep = new Map<string, (GiveUp & { agentId: string })[]>();
    for (const [agentId, g] of giveUpAgents(sessions)) byStep.set(g.step, [...(byStep.get(g.step) ?? []), { agentId, ...g }]);
    return finish(
      [...byStep].map(([step, agents]) => {
        const personas = uniq(agents.map((a) => a.personaId));
        const findingIds = findings.filter((f) => f.step === step && f.personas.some((p) => personas.includes(p))).map((f) => f.id);
        return {
          title: `Gave up at ${step}`,
          segments: segmentsOfPersonas(personas),
          personas,
          sessions: agents.length,
          quotes: agents.flatMap((a) => (a.reason ? [{ sessionId: a.sessionId, agentId: a.agentId, personaId: a.personaId, text: a.reason }] : [])),
          ...(findingIds.length ? { findingIds } : {}),
        };
      }),
    );
  }
  const byStep = new Map<string, SessionSummary[]>();
  for (const s of sessions) if (!s.valid && s.lastStep) byStep.set(s.lastStep, [...(byStep.get(s.lastStep) ?? []), s]);
  const min = Math.max(1, Math.ceil(sessions.length * 0.01));
  return finish(
    [...byStep]
      .filter(([, ss]) => ss.length >= min)
      .map(([step, ss]) => {
        const here = findings.filter((f) => f.step === step);
        const segments = SEGMENTS.map((s) => s.id).filter((id) => ss.some((s) => s.segment === id));
        return {
          title: here[0] ? `Left at ${step}: ${here[0].title}` : `Left at ${step}`,
          segments,
          personas: segments.map((id) => SEGMENTS.find((s) => s.id === id)!.personaId),
          sessions: ss.length,
          quotes: [],
          ...(here.length ? { findingIds: here.map((f) => f.id) } : {}),
        };
      }),
  );
}

