import { PERSONAS, SEGMENTS, type RunPhase, type SegmentId } from "@frictionswarm/shared";

export const PIPELINE: { phase: RunPhase; label: string; hint: string }[] = [
  { phase: "analyzing", label: "Analyze", hint: "Real users from PostHog → segment funnels and findings" },
  { phase: "fixing", label: "Fix", hint: "Coding agent fixes the top findings" },
  { phase: "waiting-preview", label: "Preview", hint: "Draft PR open, waiting for the deploy preview" },
  { phase: "retesting", label: "Re-test", hint: "Persona swarm shops the preview with fresh seeds" },
  { phase: "collecting", label: "Collect", hint: "Waiting for PostHog ingestion of the swarm's events" },
  { phase: "comparing", label: "Compare", hint: "Each persona against its segment's real users" },
  { phase: "done", label: "Done", hint: "" },
];

export const FIX_PHASES: RunPhase[] = ["fixing", "waiting-preview", "retesting", "collecting", "comparing"];
/** Phases during which the re-test swarm is (or was just) on screen. */
export const RETEST_PHASES: RunPhase[] = ["retesting", "collecting", "comparing"];

export const phaseLabel = (p: RunPhase) =>
  p === "failed" ? "Failed" : (PIPELINE.find((x) => x.phase === p)?.label ?? p);

export const isTerminal = (p: RunPhase) => p === "done" || p === "failed";

export const pct = (rate: number) => `${Math.round(rate * 100)}%`;
/** One decimal under 10% so small segment rates (4.3%) stay readable. */
export const pct1 = (rate: number) => (rate > 0 && rate < 0.1 ? `${(rate * 100).toFixed(1)}%` : pct(rate));

export const signedPts = (pts: number) => `${pts > 0 ? "+" : pts < 0 ? "−" : "±"}${Math.abs(Math.round(pts))} pts`;

export const compact = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export const shortSha = (sha?: string) => (sha && /^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 7) : sha || "—");

export function relativeTime(iso: string, now = Date.now()): string {
  const d = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return "";
  if (d < 60) return "just now";
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (d < 3600) return unit(Math.round(d / 60), "min");
  if (d < 86400) return unit(Math.round(d / 3600), "hour");
  if (d < 30 * 86400) return unit(Math.round(d / 86400), "day");
  if (d < 365 * 86400) return unit(Math.round(d / (30 * 86400)), "month");
  return unit(Math.round(d / (365 * 86400)), "year");
}

/** Retest attempt from a `<baseline>-retestN` id, if it is one. */
export const retestAttempt = (runId: string) => {
  const m = /-retest(\d+)$/.exec(runId);
  return m ? Number(m[1]) : undefined;
};

/** Last 4 characters of the run id, without the retest suffix: "2026-10-17T21-05-00-ab12" → "ab12". */
export const runIdShort = (runId: string) => runId.replace(/-retest\d+$/, "").slice(-4);

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** "Oct 17, 2026, 09:05 PM" for tooltips. */
export const formatFullDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** "Sep 19" (UTC, so a YYYY-MM-DD never shifts a day). */
export const shortDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** [from, to) as "Sep 19 – Oct 16" (to is exclusive). */
export const windowLabel = (w?: { from: string; to: string }) =>
  w ? `${shortDate(w.from)} – ${shortDate(new Date(Date.parse(`${w.to.slice(0, 10)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10))}` : "all time";

/** "Rosa", "Kai", "Typical shopper": the part of the persona name before the first comma. */
export const personaShort = (id: string) => PERSONAS[id]?.name.split(",")[0] ?? id;

/** CSS color for a persona, consistent across every view. */
export const personaColor = (id: string) =>
  PERSONAS[id] ? `var(--persona-${id.replace(/[^a-z0-9-]/gi, "")}, var(--persona-other))` : "var(--persona-other)";

const SEGMENT_SHORT: Record<SegmentId, string> = { low_vision: "Low vision", mobile: "Mobile", desktop: "Desktop" };

/** The persona that stands in for a segment on the re-test. */
export const segmentPersona = (id: string) => SEGMENTS.find((s) => s.id === id)?.personaId ?? "other";
export const segmentShort = (id: string) => SEGMENT_SHORT[id as SegmentId] ?? id;
export const segmentName = (id: string) => SEGMENTS.find((s) => s.id === id)?.name ?? id;
/** A segment wears its persona's color: the pair reads as one entity. */
export const segmentColor = (id: string) => personaColor(segmentPersona(id));
/** The segment a persona stands in for. */
export const personaSegment = (personaId: string) => SEGMENTS.find((s) => s.personaId === personaId)?.id;
