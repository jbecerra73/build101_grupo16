import { Check, CircleX } from "lucide-react";
import type { RunKind, RunPhase } from "@frictionswarm/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FIX_PHASES, PIPELINE } from "@/lib/format";
import { cn } from "@/lib/utils";

const RETEST_PIPELINE: RunPhase[] = ["retesting", "collecting", "comparing", "done"];

/**
 * analyzing → fixing → waiting-preview → retesting → collecting → comparing → done.
 * When a run finished without a fix, the fix phases show as skipped. A failed
 * run marks the phase it failed in (`failedAt`; unknown → the first phase).
 */
export function PhaseStepper({
  phase,
  kind,
  hasFix,
  failedAt,
}: {
  phase: RunPhase;
  kind: RunKind;
  hasFix: boolean;
  failedAt?: RunPhase;
}) {
  const steps = kind === "retest" ? PIPELINE.filter((p) => RETEST_PIPELINE.includes(p.phase)) : PIPELINE;
  const current = phase === "failed" ? (failedAt ?? steps[0].phase) : phase;
  const idx = steps.findIndex((s) => s.phase === current);

  return (
    <ol className="flex w-full flex-wrap items-center gap-y-2" aria-label="Pipeline phase">
      {steps.map((s, i) => {
        const skipped = phase === "done" && !hasFix && FIX_PHASES.includes(s.phase);
        const done = !skipped && (phase === "done" ? true : i < idx);
        const active = phase !== "done" && i === idx;
        const failed = phase === "failed" && i === idx;
        return (
          <li key={s.phase} className="flex flex-1 items-center gap-2 last:flex-none" aria-current={active ? "step" : undefined}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-2" tabIndex={0}>
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular",
                      done && "border-primary bg-primary text-primary-foreground",
                      active && !failed && "border-primary text-foreground ring-4 ring-primary/15",
                      failed && "border-destructive bg-destructive text-white",
                      skipped && "border-dashed text-muted-foreground",
                      !done && !active && !skipped && "text-muted-foreground",
                    )}
                  >
                    {failed ? <CircleX className="size-4" /> : done ? <Check className="size-4" /> : i + 1}
                  </span>
                  <span
                    className={cn(
                      "text-sm whitespace-nowrap",
                      active ? "font-semibold" : "text-muted-foreground",
                      skipped && "line-through decoration-muted-foreground/50",
                    )}
                  >
                    {s.label}
                    {active && !failed && <span className="ml-1.5 inline-block size-1.5 animate-pulse rounded-full bg-primary align-middle" />}
                  </span>
                </span>
              </TooltipTrigger>
              {s.hint && <TooltipContent>{s.hint}</TooltipContent>}
            </Tooltip>
            {i < steps.length - 1 && <span className={cn("mx-2 h-px min-w-4 flex-1", done ? "bg-primary" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}
