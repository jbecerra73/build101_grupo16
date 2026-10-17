"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** Stage size: scenes are laid out on a fixed 1920×1080 canvas, scaled to the window. */
export const STAGE_W = 1920;
export const STAGE_H = 1080;

const EASE = [0.22, 1, 0.36, 1] as const;

/** Fades/slides children in after `delay` seconds (opacity + transform only). */
export function Reveal({
  delay = 0,
  y = 16,
  x = 0,
  className,
  children,
  as = "div",
}: {
  delay?: number;
  y?: number;
  x?: number;
  className?: string;
  children: React.ReactNode;
  as?: "div" | "li" | "span";
}) {
  const reduced = useReducedMotion();
  const C = as === "li" ? motion.li : as === "span" ? motion.span : motion.div;
  return (
    <C
      className={className}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y, x }}
      animate={{ opacity: 1, y: 0, x: 0 }}
      transition={reduced ? { duration: 0.2, delay: Math.min(delay, 0.3) } : { duration: 0.6, delay, ease: EASE }}
    >
      {children}
    </C>
  );
}

/** Counts from 0 to `to` after `delay` s, over `duration` s (instantly with reduced motion). */
export function useCountUp(to: number, { delay = 0, duration = 1.4 }: { delay?: number; duration?: number } = {}) {
  const reduced = useReducedMotion();
  const [v, setV] = useState(0);
  useEffect(() => {
    if (reduced) {
      setV(to);
      return;
    }
    let raf = 0;
    const start = performance.now() + delay * 1000;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / (duration * 1000)));
      const e = 1 - Math.pow(1 - t, 3);
      setV(to * e);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, delay, duration, reduced]);
  return v;
}

/** Scene header: a small numbered kicker and a big title. */
export function SceneHeader({ index, kicker, title, aside, compact }: { index: number; kicker: string; title: React.ReactNode; aside?: React.ReactNode; compact?: boolean }) {
  return (
    <header className="flex items-end justify-between gap-8">
      <div className="flex min-w-0 flex-col gap-2">
        <Reveal delay={0.05} y={8}>
          <span className="flex items-center gap-3 text-lg font-medium tracking-wide text-muted-foreground uppercase">
            <span className="tabular rounded-md bg-muted px-2 py-0.5 text-foreground">{String(index + 1).padStart(2, "0")}</span>
            {kicker}
          </span>
        </Reveal>
        <Reveal delay={0.12}>
          <h1 className={cn("leading-[1.05] font-semibold tracking-tight text-balance", compact ? "text-[2.6rem]" : "text-[3.4rem]")}>{title}</h1>
        </Reveal>
      </div>
      {aside && (
        <Reveal delay={0.3} className="shrink-0">
          {aside}
        </Reveal>
      )}
    </header>
  );
}

/** Rounded panel on the stage. */
export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-3xl border bg-card/60 p-8", className)}>{children}</div>;
}

/** Colored identity dot (text stays in ink). */
export function Dot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-3.5 shrink-0 rounded-full", className)} style={{ backgroundColor: color }} />;
}


/** Scale applied to the stage (and any FitBox inside it), so layout animations inside a
 * scaled box measure in its own coordinates (MotionConfig transformPagePoint). */
export const ScaleContext = createContext(1);

export function ScaledMotion({ scale, children }: { scale: number; children: React.ReactNode }) {
  return (
    <ScaleContext.Provider value={scale}>
      <MotionConfig transformPagePoint={(p) => ({ x: p.x / scale, y: p.y / scale })}>{children}</MotionConfig>
    </ScaleContext.Provider>
  );
}

/** Shrinks its content (never grows it) to fit the box it is given, keeping it crisp and
 * animation-safe. Shrink-only while mounted, eased, so growing content never jumps. */
export function FitBox({ children, className, innerClassName }: { children: React.ReactNode; className?: string; innerClassName?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const parent = useContext(ScaleContext);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [k, setK] = useState(1);

  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setBox({ w: el.offsetWidth, h: el.offsetHeight });
      setK(1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || !box.h) return;
    const fit = () => {
      const h = el.offsetHeight;
      if (h > 0) setK((cur) => Math.min(cur, box.h / h));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [box]);

  return (
    <div ref={outer} className={cn("relative min-h-0", className)}>
      <div
        ref={inner}
        className={cn("absolute top-0 left-0 flex origin-top-left flex-col transition-transform duration-500 ease-out", innerClassName)}
        style={{ width: box.w ? box.w / k : "100%", minHeight: box.h ? box.h / k : undefined, transform: `scale(${k})` }}
      >
        <ScaledMotion scale={parent * k}>{children}</ScaledMotion>
      </div>
    </div>
  );
}
