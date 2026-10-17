// Friction signals: session marks aggregated over a run, per group (segment for real users,
// persona for a swarm), with dwell, example sessions, quotes and the release that introduced them.
import type { Flow, Release, RunKind, SegmentId } from "@frictionswarm/shared";
import { releaseRates, type History } from "./history";
import { median } from "./metrics";
import { attributeRelease } from "./releases";
import type { MarkKind, SessionSummary } from "./sessions";

export type SignalGroup = {
  /** SegmentId (analysis) or persona id (retest). */
  id: string;
  /** Affected sessions in the group. */
  sessions: number;
  /** Group sessions that reached the signal's step. */
  reached: number;
  rate: number;
  /** drop_off: median ms on the page before leaving (unexplained exits). */
  exitDwellMs?: number;
};

export type DwellClass = "short" | "long" | "normal";

export type Signal = {
  /** S1..Sn, by lost sessions. */
  id: string;
  /** `${kind}|${step}|${detail}` (stable across runs and releases). */
  key: string;
  kind: MarkKind;
  step: string;
  /** Flow route of the step. */
  page: string;
  selector?: string;
  label?: string;
  /** Raw $elements_chain (rage clicks). */
  chain?: string;
  event?: string;
  /** Most common error_fields, most frequent first. */
  fields?: string[];
  /** Affected sessions / distinct users / underlying events. */
  sessions: number;
  users: number;
  events: number;
  /** Affected sessions that left at this step without completing. */
  exits: number;
  groups: SignalGroup[];
  /** drop_off: exit vs pass-through dwell on the step. */
  dwell?: { exitMedianMs: number; passMedianMs: number; class: DwellClass };
  /** Analysis runs: first release where this signal's rate jumped (over its affected groups). */
  sinceRelease?: Release;
  /** Strong enough to be a finding on its own (see isStrong). */
  strong: boolean;
  exampleSessions: string[];
  /** Retest: swarm_give_up reasons / swarm_think_aloud notes from affected agents, verbatim. */
  quotes: string[];
  /** Affected $session_ids (not sent to the model). */
  sessionIds: string[];
};

export type SignalOptions = {
  kind: RunKind;
  /** Analysis runs: release attribution. */
  history?: History;
  /** Fewest affected sessions for a signal to count. Default 3 (analysis), 1 (retest). */
  minSessions?: number;
};

/** A group is affected when its rate is at least this share of the worst group's. */
export const AFFECTED_SHARE = 0.6;

export const groupOf = (kind: RunKind) => (s: SessionSummary) => (kind === "retest" ? (s.personaId ?? "unknown") : s.segment);

export function pageOf(flow: Flow, step: string): string {
  return flow.steps.find((s) => s.name === step)?.route.split("?")[0] ?? step;
}

/** Groups whose rate is high enough to call them affected (worst first). */
export function affectedGroups(sig: Pick<Signal, "groups">, minSessions = 1, share = AFFECTED_SHARE): SignalGroup[] {
  const ok = sig.groups.filter((g) => g.sessions >= minSessions && g.reached > 0);
  const max = Math.max(0, ...ok.map((g) => g.rate));
  return ok.filter((g) => g.rate >= share * max && g.rate > 0).sort((a, b) => b.rate - a.rate);
}

const top = <T>(xs: T[], n: number) => {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([x]) => x);
};

function classify(exit: number[], pass: number[]): Signal["dwell"] | undefined {
  if (exit.length < 3 || pass.length < 3) return undefined;
  const e = median(exit), p = median(pass);
  return { exitMedianMs: Math.round(e), passMedianMs: Math.round(p), class: e < 0.5 * p ? "short" : e > 2 * p ? "long" : "normal" };
}

/** Aggregate session marks into signals. Pure. */
export function frictionSignals(flow: Flow, sessions: SessionSummary[], opts: SignalOptions): Signal[] {
  const retest = opts.kind === "retest";
  const minSessions = opts.minSessions ?? (retest ? 1 : 3);
  const group = groupOf(opts.kind);
  const groupIds = [...new Set(sessions.map(group))];
  const reached = new Map<string, number>(); // `${group}|${step}`
  const pass = new Map<string, number[]>(); // step → pass-through dwell
  for (const s of sessions) {
    for (const step of new Set(s.steps)) reached.set(`${group(s)}|${step}`, (reached.get(`${group(s)}|${step}`) ?? 0) + 1);
    for (const d of s.dwell) if (!d.last) (pass.get(d.step) ?? pass.set(d.step, []).get(d.step)!).push(d.ms);
  }
  const exitedAt = (s: SessionSummary, step: string) => !s.valid && s.lastStep === step;

  type Acc = { sessions: SessionSummary[]; events: number; fields: string[]; dwell: { g: string; ms: number }[] };
  const accs = new Map<string, Acc & { first: SessionSummary["marks"][number] }>();
  for (const s of sessions)
    for (const m of s.marks) {
      let a = accs.get(m.key);
      if (!a) accs.set(m.key, (a = { first: m, sessions: [], events: 0, fields: [], dwell: [] }));
      a.sessions.push(s);
      a.events += m.count;
      if (m.fields) a.fields.push(...m.fields);
      if (m.kind === "drop_off" && !m.explained && m.dwellMs !== undefined) a.dwell.push({ g: group(s), ms: m.dwellMs });
    }

  const signals: Omit<Signal, "id">[] = [];
  for (const [key, a] of accs) {
    const m = a.first;
    if (a.sessions.length < minSessions) continue;
    const groups = groupIds
      .map((id): SignalGroup => {
        const n = a.sessions.filter((s) => group(s) === id).length;
        const r = reached.get(`${id}|${m.step}`) ?? 0;
        const dw = a.dwell.filter((d) => d.g === id).map((d) => d.ms);
        return { id, sessions: n, reached: r, rate: r ? n / r : 0, ...(m.kind === "drop_off" && dw.length ? { exitDwellMs: Math.round(median(dw)) } : {}) };
      })
      .filter((g) => g.reached > 0);
    const ordered = a.sessions.toSorted((x, y) => Number(exitedAt(y, m.step)) - Number(exitedAt(x, m.step)) || x.start - y.start);
    const quotes = retest ? quotesFor(m.kind, m.step, ordered) : [];
    const sig: Omit<Signal, "id"> = {
      key,
      kind: m.kind,
      step: m.step,
      page: pageOf(flow, m.step),
      ...(m.selector && { selector: m.selector }),
      ...(m.label && { label: m.label }),
      ...(m.chain && { chain: m.chain }),
      ...(m.event && { event: m.event }),
      ...(a.fields.length && { fields: top(a.fields, 8) }),
      sessions: a.sessions.length,
      users: new Set(a.sessions.map((s) => s.distinctId)).size,
      events: a.events,
      exits: a.sessions.filter((s) => exitedAt(s, m.step)).length,
      groups,
      ...(m.kind === "drop_off" && { dwell: classify(a.dwell.map((d) => d.ms), pass.get(m.step) ?? []) }),
      strong: false,
      exampleSessions: ordered.slice(0, 3).map((s) => s.id),
      quotes,
      sessionIds: ordered.map((s) => s.id),
    };
    if (!sig.dwell) delete sig.dwell;
    if (opts.history) {
      const affected = affectedGroups(sig, minSessions).map((g) => g.id) as SegmentId[];
      const since = attributeRelease(releaseRates(opts.history, key, affected.length ? affected : (groupIds as SegmentId[])));
      if (since) sig.sinceRelease = since;
    }
    sig.strong = isStrong(sig, opts.history, minSessions, retest);
    signals.push(sig);
  }
  return signals
    .sort((x, y) => Number(y.strong) - Number(x.strong) || y.exits - x.exits || y.sessions - x.sessions || x.key.localeCompare(y.key))
    .map((s, i) => ({ id: `S${i + 1}`, ...s }));
}

/** Strong = a finding on its own. Rage clicks, size-less add-to-cart and wiped forms always are
 * (above noise); a failed submit when people leave after it; a drop-off when its dwell is
 * abnormal (short = surprise, long = stuck) or a release made it jump; a swarm give-up always. */
export function isStrong(s: Omit<Signal, "id">, history: History | undefined, minSessions: number, retest: boolean): boolean {
  const reachedAll = s.groups.reduce((n, g) => n + g.reached, 0);
  const rate = reachedAll ? s.sessions / reachedAll : 0;
  const maxGroupRate = Math.max(0, ...s.groups.filter((g) => g.sessions >= minSessions).map((g) => g.rate));
  switch (s.kind) {
    case "rage_click":
      return s.sessions >= minSessions && rate >= 0.01;
    case "no_size":
      return rate >= 0.05;
    case "promo_wipe":
      return s.sessions >= minSessions;
    case "failed_submit":
      return s.exits / s.sessions >= 0.2;
    case "give_up":
      return true;
    case "drop_off": {
      if (retest) return s.exits >= 1;
      if (maxGroupRate < 0.05) return false;
      if (s.dwell && s.dwell.class !== "normal" && s.exits >= 10) return true;
      const first = history?.releases[0]?.sha;
      return !!s.sinceRelease && s.sinceRelease.sha !== first;
    }
  }
}

function quotesFor(kind: MarkKind, step: string, sessions: SessionSummary[]): string[] {
  const notes = sessions.flatMap((s) => s.notes.filter((n) => n.step === step || (kind === "give_up" && n.kind === "give_up")));
  const ordered = [...notes.filter((n) => n.kind === "give_up"), ...notes.filter((n) => n.kind === "think_aloud")];
  return [...new Set(ordered.map((n) => n.text))].slice(0, 3);
}
