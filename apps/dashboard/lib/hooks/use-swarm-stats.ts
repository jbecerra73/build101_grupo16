"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentState } from "@/lib/types";

export type SwarmStats = {
  n: number;
  running: number;
  done: number;
  valid: number;
  gaveUp: number;
  invalid: number;
  actions: number;
  /** Actions per second of swarm time over the last ~5 s (whole-run average once finished). */
  aps: number;
  /** First event → latest event, in swarm time (ms). */
  elapsedMs: number;
};

const WINDOW_MS = 5000;

/** Live counters for the swarm map. Time is the event clock (the agents' own
 * timestamps), so live runs and Replay compute the same numbers. */
export function useSwarmStats(agents: AgentState[]): SwarmStats {
  const n = agents.length;
  const running = agents.filter((a) => a.state === "running").length;
  const valid = agents.filter((a) => a.state === "success").length;
  const gaveUp = agents.filter((a) => a.state === "gave-up").length;
  const invalid = agents.filter((a) => a.state === "invalid").length;
  const actions = agents.reduce((s, a) => s + a.actions, 0);
  const starts = agents.map((a) => a.startedAt).filter((t): t is number => !!t);
  const ends = agents.map((a) => a.lastEventAt).filter((t): t is number => !!t);
  const start = starts.length ? Math.min(...starts) : 0;
  const clock = ends.length ? Math.max(...ends) : 0;
  const elapsedMs = start ? clock - start : 0;

  const samples = useRef<{ t: number; a: number }[]>([]);
  const [aps, setAps] = useState(0);

  useEffect(() => {
    const s = samples.current;
    // Replay seeked backwards: start over.
    if (s.length && (clock < s.at(-1)!.t || actions < s.at(-1)!.a)) s.length = 0;
    s.push({ t: clock, a: actions });
    while (s.length > 2 && s[1].t <= clock - WINDOW_MS) s.shift();
    if (running === 0) {
      setAps(elapsedMs > 0 ? actions / (elapsedMs / 1000) : 0);
      return;
    }
    const first = s[0];
    const dt = (clock - first.t) / 1000;
    if (dt >= 0.5) setAps((actions - first.a) / dt);
    else if (elapsedMs > 0 && s.length === 1) setAps(actions / Math.max(1, elapsedMs / 1000));
  }, [clock, actions, running, elapsedMs]);

  return { n, running, done: n - running, valid, gaveUp, invalid, actions, aps, elapsedMs };
}
