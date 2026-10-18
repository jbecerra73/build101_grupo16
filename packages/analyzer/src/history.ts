// Months of real-user history, reduced to what the trend chart and release attribution
// need: per release × segment, sessions, completions, step reach and mark counts; per week ×
// segment, completion. Built in one streaming pass and written to runs/<id>/history.json, so a
// run replays offline without its months of raw events.
import { SEGMENTS, type Flow, type PostHogEvent, type Release, type SegmentId, type TrendPoint } from "@frictionswarm/shared";
import { deriveReleases, KNOWN_RELEASES, type ReleaseRate } from "./releases";
import { countsForFlow, streamSessions, summarizeSession, type SessionSummary } from "./sessions";

export type ReleaseSegmentStats = {
  n: number;
  completed: number;
  completionRate: number;
  /** Sessions whose $pageviews include each step. */
  reached: Record<string, number>;
  /** Sessions with each mark key (see Mark). */
  marks: Record<string, number>;
};

export type ReleaseStats = Release & { segments: Partial<Record<SegmentId, ReleaseSegmentStats>> };

export type History = {
  /** Window the history covers, [from, to). */
  from: string;
  to: string;
  sessions: number;
  releases: Release[];
  byRelease: ReleaseStats[];
  trend: TrendPoint[];
};

const DAY = 86_400_000;
/** Monday of the UTC week, YYYY-MM-DD. */
export const weekStart = (ts: number) => {
  const d = new Date(ts);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - back * DAY).toISOString().slice(0, 10);
};

const segmentOrder = (id: SegmentId) => SEGMENTS.findIndex((s) => s.id === id);

/** Accumulates session summaries (any order) into a History. */
export class HistoryBuilder {
  private firstSeen = new Map<string, number>();
  private stats = new Map<string, Map<SegmentId, ReleaseSegmentStats>>();
  private weeks = new Map<string, { n: number; completed: number }>();
  private count = 0;

  add(s: SessionSummary) {
    this.count++;
    const seen = this.firstSeen.get(s.buildSha);
    if (seen === undefined || s.start < seen) this.firstSeen.set(s.buildSha, s.start);
    let bySeg = this.stats.get(s.buildSha);
    if (!bySeg) this.stats.set(s.buildSha, (bySeg = new Map()));
    let st = bySeg.get(s.segment);
    if (!st) bySeg.set(s.segment, (st = { n: 0, completed: 0, completionRate: 0, reached: {}, marks: {} }));
    st.n++;
    if (s.valid) st.completed++;
    for (const step of new Set(s.steps)) st.reached[step] = (st.reached[step] ?? 0) + 1;
    for (const m of s.marks) st.marks[m.key] = (st.marks[m.key] ?? 0) + 1;
    const wk = `${weekStart(s.start)}|${s.segment}`;
    const w = this.weeks.get(wk) ?? { n: 0, completed: 0 };
    w.n++;
    if (s.valid) w.completed++;
    this.weeks.set(wk, w);
  }

  build(range: { from: string; to: string }, known: Release[] = KNOWN_RELEASES): History {
    const releases = deriveReleases(this.firstSeen, known);
    const byRelease = releases.map((r): ReleaseStats => {
      const segs = [...(this.stats.get(r.sha) ?? new Map<SegmentId, ReleaseSegmentStats>())].sort((a, b) => segmentOrder(a[0]) - segmentOrder(b[0]));
      return {
        ...r,
        segments: Object.fromEntries(segs.map(([id, st]) => [id, { ...st, completionRate: st.n ? st.completed / st.n : 0 }])),
      };
    });
    const trend = [...this.weeks]
      .map(([k, w]): TrendPoint => {
        const [week, segmentId] = k.split("|") as [string, SegmentId];
        return { segmentId, weekStart: week, n: w.n, completed: w.completed, completionRate: w.n ? w.completed / w.n : 0 };
      })
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || segmentOrder(a.segmentId) - segmentOrder(b.segmentId));
    return { from: range.from, to: range.to, sessions: this.count, releases, byRelease, trend };
  }
}

export function historyFromSummaries(summaries: Iterable<SessionSummary>, range: { from: string; to: string }, known?: Release[]): History {
  const b = new HistoryBuilder();
  for (const s of summaries) b.add(s);
  return b.build(range, known);
}

/** Stream events into a History without holding them (sessions are digested as they close). */
export async function historyFromEvents(
  flow: Flow,
  events: AsyncIterable<PostHogEvent>,
  range: { from: string; to: string },
  opts: { known?: Release[]; onSession?: (s: SessionSummary, events: PostHogEvent[]) => void } = {},
): Promise<History> {
  const b = new HistoryBuilder();
  for await (const evs of streamSessions(events)) {
    if (!countsForFlow(flow, evs)) continue;
    const s = summarizeSession(flow, evs);
    b.add(s);
    opts.onSession?.(s, evs);
  }
  return b.build(range, opts.known);
}

/** A mark's rate per release over some segments: sessions with the mark / sessions that reached its step. */
export function releaseRates(history: History, key: string, segments: SegmentId[]): ReleaseRate[] {
  const step = key.split("|")[1];
  return history.byRelease.map((r) => {
    let count = 0, reached = 0;
    for (const id of segments) {
      const st = r.segments[id];
      if (!st) continue;
      count += st.marks[key] ?? 0;
      reached += st.reached[step] ?? 0;
    }
    const { segments: _, ...release } = r;
    return { release, count, reached, rate: reached ? count / reached : 0 };
  });
}
