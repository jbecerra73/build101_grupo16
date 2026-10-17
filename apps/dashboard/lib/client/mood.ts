import type { AgentState } from "@/lib/types";

/** Visual mood of a persona avatar, derived from the agent's live state. */
export type Mood = "idle" | "running" | "struggling" | "gave-up" | "success" | "invalid";

/** Think-aloud phrasing that signals confusion (Rosa can't read it, Kai can't hit it). */
const CONFUSED = /can'?t|cannot|couldn'?t|where('?s| is)|confus|tiny|too small|hard to|not sure|unclear|blurr|missed|nothing happen|\?/i;

/** running → struggling once an agent misses repeatedly or thinks aloud in confusion. */
export function moodOf(a: Pick<AgentState, "state" | "missedActions" | "lastNote" | "actions">): Mood {
  switch (a.state) {
    case "success":
      return "success";
    case "gave-up":
      return "gave-up";
    case "invalid":
      return "invalid";
    case "stopped":
      return "idle";
    default:
      if (a.missedActions >= 2 || (a.lastNote && CONFUSED.test(a.lastNote))) return "struggling";
      return a.actions > 0 || a.lastNote ? "running" : "idle";
  }
}

export const MOOD_LABEL: Record<Mood, string> = {
  idle: "waiting",
  running: "browsing",
  struggling: "struggling",
  "gave-up": "gave up",
  success: "checked out",
  invalid: "invalid completion",
};
