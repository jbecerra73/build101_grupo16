"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Event } from "@frictionswarm/shared";

/** Plays an event log back on a clock: `shown` = how many events are visible at
 * `pos` ms after the first event. Used by Replay on the run page and by pitch mode. */
export function useReplay(events: Event[], enabled: boolean, opts: { speed?: number; autoplay?: boolean } = {}) {
  const t0 = events[0]?.ts ?? 0;
  const length = events.length ? events.at(-1)!.ts - t0 : 0;
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState((opts.autoplay ?? true) && enabled && events.length > 0);
  const [speed, setSpeed] = useState(opts.speed ?? 4);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !playing) return;
    // A timer (not rAF) so playback also advances in background tabs and headless capture.
    last.current = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      const dt = now - (last.current ?? now);
      last.current = now;
      setPos((p) => Math.min(length, p + dt * speed));
    }, 50);
    return () => {
      clearInterval(t);
      last.current = null;
    };
  }, [enabled, playing, speed, length]);

  useEffect(() => {
    if (playing && pos >= length) setPlaying(false);
  }, [playing, pos, length]);

  const shown = useMemo(() => {
    const cut = t0 + pos;
    let i = 0;
    while (i < events.length && events[i].ts <= cut) i++;
    return i;
  }, [events, pos, t0]);

  const restart = useCallback(() => {
    setPos(0);
    setPlaying(true);
  }, []);

  return { pos, setPos, playing, setPlaying, speed, setSpeed, length, shown, atEnd: pos >= length, restart, clock: t0 + pos };
}
