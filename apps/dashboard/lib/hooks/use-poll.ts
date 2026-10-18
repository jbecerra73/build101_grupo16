"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Polls `fn` while `enabled`, waiting `ms` after each call settles so a slow
 * response never overlaps the next poll. Keeps the last good value on errors. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, enabled = true) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [lastOk, setLastOk] = useState<number | undefined>(undefined);
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });

  const refresh = useCallback(async () => {
    try {
      const v = await ref.current();
      setData(v);
      setError(undefined);
      setLastOk(Date.now());
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (alive) t = setTimeout(tick, ms);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [ms, enabled, refresh]);

  return { data, error, lastOk, refresh };
}

/** Re-renders every `ms` (for "last seen 3s ago" style labels). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
