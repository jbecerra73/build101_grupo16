"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Polls `fn` every `ms` while `enabled`. Keeps the last good value on errors. */
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
    const tick = async () => {
      if (alive) await refresh();
    };
    void tick();
    const t = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(t);
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
