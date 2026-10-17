import type { Release } from "./sim";

type Session = { ts: number; sha: string; segment: string; completed: boolean; exitStep: string };

/** Per release and segment: completion rate and where sessions ended. Written
 * to the manifest so the dataset's story can be checked without the analyzer. */
export function summarize(sessions: Session[], releases: Release[]) {
  return releases.map((r) => {
    const own = sessions.filter((s) => s.sha === r.sha);
    const segments: Record<string, { sessions: number; completed: number; completionRate: number; exits: Record<string, number> }> = {};
    for (const s of own) {
      const m = (segments[s.segment] ??= { sessions: 0, completed: 0, completionRate: 0, exits: {} });
      m.sessions++;
      if (s.completed) m.completed++;
      else m.exits[s.exitStep] = (m.exits[s.exitStep] ?? 0) + 1;
    }
    for (const m of Object.values(segments)) m.completionRate = Math.round((m.completed / m.sessions) * 1000) / 1000;
    return { sha: r.sha, date: r.date, name: r.name, traps: r.traps, segments };
  });
}
