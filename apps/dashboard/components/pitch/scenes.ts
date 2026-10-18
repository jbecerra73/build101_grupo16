import { pct1, personaShort, segmentShort, signedPts } from "@/lib/format";
import type { PitchData } from "./data";

export type SceneId = "problem" | "posthog" | "fix" | "swarm" | "before-after" | "trust" | "vision";

export type SceneMeta = {
  id: SceneId;
  title: string;
  /** Time budget in the 3-minute pitch (SPEC: Pitch). */
  seconds: number;
  notes: (d: PitchData) => string[];
};

export const SCENES: SceneMeta[] = [
  {
    id: "problem",
    title: "Problem",
    seconds: 20,
    notes: (d) => {
      const worst = d.impacts.toSorted((a, b) => a.deltaPts - b.deltaPts)[0];
      return [
        "PMs ship checkout changes blind: nobody watches every segment after a release.",
        worst
          ? `On this store, “${worst.release.name}” took ${segmentShort(worst.segmentId)} completion from ${pct1(worst.before)} to ${pct1(worst.after)}, and nobody noticed for weeks.`
          : "Friction shows up as drop-off in the analytics, weeks after the release that caused it.",
        "By then real customers have already left. A/B tests take weeks of traffic to say anything.",
      ];
    },
  },
  {
    id: "posthog",
    title: "Six months of PostHog",
    seconds: 40,
    notes: (d) => [
      "This is the store's real PostHog data: weekly checkout completion per segment, real users only.",
      "Vertical lines are production releases. Wait for the rings: each marks the release that broke a segment.",
      ...d.impacts.map((i) => `${segmentShort(i.segmentId)} broke with “${i.release.name}”: ${pct1(i.before)} → ${pct1(i.after)}.`),
      `The analyzer turns that into ${d.findings.length} findings, each with its evidence and the release that introduced it.`,
    ],
  },
  {
    id: "fix",
    title: "The fix",
    seconds: 30,
    notes: (d) => [
      `The top findings go to a coding agent (Claude Code, headless) with the storefront repo; it pushes a branch and opens a draft PR.`,
      d.attempt?.findingIds.length ? `It targeted ${d.attempt.findingIds.join(" and ")}.` : "It targets the top 1–3 findings.",
      "Say it plainly if the badge reads rehearsal: on stage the fix loop is recorded, the rest is the same pipeline.",
      "Netlify builds a deploy preview; the orchestrator waits until the preview serves the pushed commit.",
    ],
  },
  {
    id: "swarm",
    title: "Swarm re-test",
    seconds: 30,
    notes: (d) => [
      d.live ? "This is live: the swarm is shopping the preview right now." : "Replayed from the re-test's PostHog snapshot, at speed.",
      "Each face is an agent with a persona's constraints enforced: Rosa sees a blurred, downscaled screen; Kai misses taps under 44px.",
      "They walk the funnel left to right. Give-ups drop into ‘Left the store’ with their reason; valid orders land in ‘Checked out’.",
      `${d.retest?.agents.length ?? 30} agents, fresh seeds, tagged so they never touch real-user metrics.`,
    ],
  },
  {
    id: "before-after",
    title: "Before / after",
    seconds: 30,
    notes: (d) => {
      const v = d.attempt?.verdict;
      if (!v) return ["The verdict appears once the swarm's tracks are compared. If it's still running, go back to the swarm."];
      return [
        "Before: the segment's real users on production. After: the persona swarm on the preview. N on both sides.",
        ...v.comparisons.map((c) => `${segmentShort(c.segmentId)} ↔ ${personaShort(c.personaId)}: ${signedPts(c.completionDeltaPts)}${c.regressions.length ? ` (regressions: ${c.regressions.length})` : ""}.`),
        "Different populations: a directional pre-merge check, not an A/B test.",
        v.improved ? "Proven against the threshold: the PR is marked ready for review." : "Not proven: the PR gets a metrics comment, the not-proven label and is closed. We show failures honestly.",
      ];
    },
  },
  {
    id: "trust",
    title: "Why trust it",
    seconds: 20,
    notes: () => [
      "Evidence first: findings come from real users in PostHog, not from the agents.",
      "The personas' limits are enforced on what the model sees and can do, not just prompted: that's Rosa's view, and Kai's 44px grid.",
      "A control persona must not regress; re-tests use fresh seeds; completions need the required steps, so shortcuts don't count.",
      "On the planted-trap history, it found all five traps and the release that introduced each.",
    ],
  },
  {
    id: "vision",
    title: "Vision",
    seconds: 10,
    notes: () => ["CI for UX: every storefront PR gets checked by real-user evidence plus a persona swarm, before any customer sees it.", "Thank you."],
  },
];

export const TOTAL_SECONDS = SCENES.reduce((n, s) => n + s.seconds, 0);

/** Start offset of a scene in the pitch, in seconds. */
export const sceneStart = (i: number) => SCENES.slice(0, i).reduce((n, s) => n + s.seconds, 0);

export const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
