import { PERSONAS, type RunPhase } from "@frictionswarm/shared";

export const PIPELINE: { phase: RunPhase; label: string }[] = [
  { phase: "verifying", label: "Verify build" },
  { phase: "swarming", label: "Swarm" },
  { phase: "analyzing", label: "Analyze" },
  { phase: "fixing", label: "Fix" },
  { phase: "waiting-preview", label: "Preview" },
  { phase: "retesting", label: "Retest" },
  { phase: "comparing", label: "Compare" },
  { phase: "done", label: "Done" },
];

export const phaseLabel = (p: RunPhase) =>
  p === "failed" ? "Failed" : (PIPELINE.find((x) => x.phase === p)?.label ?? p);

export const isTerminal = (p: RunPhase) => p === "done" || p === "failed";

export const pct = (rate: number) => `${Math.round(rate * 100)}%`;

export const signedPts = (pts: number) => `${pts > 0 ? "+" : pts < 0 ? "−" : "±"}${Math.abs(Math.round(pts))} pts`;

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export const shortSha = (sha?: string) => (sha && /^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 7) : (sha ?? "—"));

export function relativeTime(iso: string, now = Date.now()): string {
  const d = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return "";
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** "Rosa", "Kai", "Typical shopper": the part of the persona name before the first comma. */
export const personaShort = (id: string) => PERSONAS[id]?.name.split(",")[0] ?? id;

/** CSS color for a persona, consistent across every view. */
export const personaColor = (id: string) =>
  PERSONAS[id] ? `var(--persona-${id.replace(/[^a-z0-9-]/gi, "")}, var(--persona-other))` : "var(--persona-other)";
