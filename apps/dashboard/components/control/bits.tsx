"use client";

import { Check, X } from "lucide-react";
import type { Metrics, RunPhase } from "@frictionswarm/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PIPELINE, phaseLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Live heartbeat: a pulsing dot (transform/opacity ping) when online. */
export function HeartbeatDot({ online, size = "md" }: { online: boolean; size?: "md" | "lg" }) {
  const s = size === "lg" ? "size-4" : "size-2.5";
  const color = online ? "var(--status-good)" : "var(--muted-foreground)";
  return (
    <span className={cn("relative inline-flex shrink-0", s)} aria-hidden>
      {online && <span className="absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping" style={{ backgroundColor: color }} />}
      <span className={cn("relative inline-flex rounded-full", s)} style={{ backgroundColor: color }} />
    </span>
  );
}

/** Compact phase stepper for table rows: one dot per phase, the current one pulses. */
export function MiniStepper({ phase, failedAt }: { phase: RunPhase; failedAt?: RunPhase }) {
  const current = phase === "failed" ? (failedAt ?? "analyzing") : phase;
  const idx = PIPELINE.findIndex((p) => p.phase === current);
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex items-center" aria-label={`Pipeline at ${phaseLabel(phase)}`}>
        {PIPELINE.map((p, i) => {
          const done = phase === "done" || i < idx;
          const active = i === idx && phase !== "done";
          const failed = phase === "failed" && i === idx;
          return (
            <li key={p.phase} className="flex items-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className={cn(
                      "relative flex size-5 items-center justify-center rounded-full border text-[0.6rem]",
                      done && "border-foreground bg-foreground text-background",
                      active && !failed && "border-[var(--status-running)] bg-background",
                      failed && "border-[var(--status-critical)] bg-[var(--status-critical)] text-white",
                      !done && !active && "border-border bg-background",
                    )}
                  >
                    {failed ? <X className="size-3" /> : done ? <Check className="size-3" /> : null}
                    {active && !failed && (
                      <>
                        <span className="absolute inset-0 rounded-full bg-[var(--status-running)]/40 motion-safe:animate-ping" />
                        <span className="size-2 rounded-full bg-[var(--status-running)]" />
                      </>
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{p.label}</TooltipContent>
              </Tooltip>
              {i < PIPELINE.length - 1 && <span className={cn("h-0.5 w-3", i < idx || phase === "done" ? "bg-foreground" : "bg-border")} />}
            </li>
          );
        })}
      </ol>
      <span className="text-sm font-medium">{phaseLabel(phase)}</span>
    </div>
  );
}

/** Tiny funnel: share of all sessions (segments) or agents (personas) that
 * reached each step (one neutral series). */
export function MiniFunnel({ metrics }: { metrics?: Metrics }) {
  const groups: { n: number; funnel: { step: string; reached: number; droppedHere: number }[] }[] = metrics?.segments.length ? metrics.segments : (metrics?.personas ?? []);
  const steps = groups[0]?.funnel.map((f) => f.step) ?? [];
  const n = groups.reduce((s, p) => s + p.n, 0);
  if (!steps.length || !n) return <span className="text-sm text-muted-foreground">Analyzing…</span>;
  return (
    <div className="flex h-10 items-end gap-0.5" role="img" aria-label={`Funnel: ${steps.join(", ")}`}>
      {steps.map((s) => {
        const reached = groups.reduce((t, p) => t + (p.funnel.find((f) => f.step === s)?.reached ?? 0), 0);
        const left = groups.reduce((t, p) => t + (p.funnel.find((f) => f.step === s)?.droppedHere ?? 0), 0);
        return (
          <Tooltip key={s}>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="flex h-full w-3.5 items-end rounded-[3px] bg-muted">
                <span
                  className="block w-full origin-bottom rounded-[3px] bg-foreground/60 transition-transform duration-700"
                  style={{ height: "100%", transform: `scaleY(${reached / n})` }}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {s}: {reached}/{n} reached{left ? `, ${left} left here` : ""}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Runs-per-day meter: the fill carries severity (accent → warning → critical). */
export function UsageMeter({ used, max }: { used: number; max: number }) {
  const frac = max ? Math.min(1, used / max) : 0;
  const color = frac >= 1 ? "var(--status-critical)" : frac >= 0.8 ? "var(--status-warning)" : "var(--status-running)";
  return (
    <div
      className="h-3 w-full overflow-hidden rounded-full"
      style={{ backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)` }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={used}
      aria-label="Runs used today"
    >
      <div className="h-full origin-left rounded-full transition-transform duration-700" style={{ backgroundColor: color, transform: `scaleX(${frac})` }} />
    </div>
  );
}
