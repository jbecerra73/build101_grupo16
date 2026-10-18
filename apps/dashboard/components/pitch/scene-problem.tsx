"use client";

import { motion, useReducedMotion } from "motion/react";
import { Rocket, TrendingDown, Users } from "lucide-react";
import { pct1, segmentColor, segmentShort, shortDate } from "@/lib/format";
import type { PitchData } from "./data";
import { Dot, Reveal } from "./parts";

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-14" aria-hidden>
      <circle cx="7" cy="8" r="4" fill="var(--persona-rosa)" />
      <circle cx="17" cy="9" r="3.4" fill="var(--persona-kai)" />
      <circle cx="11" cy="17.5" r="3.8" fill="var(--persona-typical)" />
    </svg>
  );
}

export function SceneProblem({ d }: { d: PitchData }) {
  const reduced = useReducedMotion();
  // The segment this store broke the hardest, relative to where it was.
  const worst = d.impacts.toSorted((a, b) => a.after / a.before - b.after / b.before)[0];
  const lastWeek = d.run.metrics?.trend?.points.map((p) => p.weekStart).sort().at(-1);
  const weeksLater = worst && lastWeek ? Math.round((Date.parse(lastWeek) - Date.parse(worst.release.date)) / (7 * 86_400_000)) : undefined;

  const steps = worst
    ? [
        { icon: Rocket, top: shortDate(worst.release.date), main: `“${worst.release.name}” ships`, sub: "the release looks fine in review" },
        { icon: Users, top: weeksLater ? `${weeksLater} weeks of traffic` : "weeks of traffic", main: "Customers quietly leave", sub: "nobody watches every segment" },
        {
          icon: TrendingDown,
          top: "the dashboard, weeks later",
          main: (
            <span className="flex items-center gap-3">
              <Dot color={segmentColor(worst.segmentId)} className="size-5" />
              {segmentShort(worst.segmentId)} {pct1(worst.before)} → {pct1(worst.after)}
            </span>
          ),
          sub: "completion, real users",
        },
      ]
    : [];

  return (
    <div className="flex h-full flex-col justify-between">
      <Reveal delay={0} y={0} className="flex items-center gap-4">
        <Logo />
        <span className="text-4xl font-semibold tracking-tight">FrictionSwarm</span>
      </Reveal>

      <div className="flex flex-col gap-10">
        <Reveal delay={0.15}>
          <h1 className="max-w-[1500px] text-[8.5rem] leading-[0.95] font-semibold tracking-tight">POs ship flows blind.</h1>
        </Reveal>
        <Reveal delay={0.55}>
          <p className="max-w-[1400px] text-6xl leading-tight text-muted-foreground">
            Friction shows up as <span className="text-foreground">drop-off</span>, weeks later.
          </p>
        </Reveal>
      </div>

      {steps.length ? (
        <ol className="relative grid grid-cols-3 gap-10" aria-label="How friction is found today">
          {/* the timeline draws left to right */}
          <motion.span
            aria-hidden
            className="absolute top-9 right-[16%] left-[4%] h-0.5 origin-left bg-border"
            initial={reduced ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1.6, delay: 1, ease: "easeInOut" }}
          />
          {steps.map((s, i) => (
            <Reveal key={i} as="li" delay={1 + i * 0.6} className="relative flex flex-col gap-3">
              <span className={i === 2 ? "flex size-[4.5rem] items-center justify-center rounded-full bg-[var(--status-critical)] text-white" : "flex size-[4.5rem] items-center justify-center rounded-full border-2 bg-background"}>
                <s.icon className="size-8" aria-hidden />
              </span>
              <span className="text-xl tracking-wide text-muted-foreground uppercase">{s.top}</span>
              <span className="tabular text-4xl font-semibold">{s.main}</span>
              <span className="text-2xl text-muted-foreground">{s.sub}</span>
            </Reveal>
          ))}
        </ol>
      ) : (
        <span />
      )}
    </div>
  );
}
