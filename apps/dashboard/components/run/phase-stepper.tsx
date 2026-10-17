import { Check, CircleX } from "lucide-react";
import type { RunKind, RunPhase } from "@frictionswarm/shared";
import { PIPELINE } from "@/lib/format";
import { cn } from "@/lib/utils";

const RETEST_PIPELINE: RunPhase[] = ["swarming", "analyzing", "done"];

/**
 * verifying → swarming → … → done. When a run finished without a fix, the fix
 * phases show as skipped. A failed run marks the phase it failed in, which the
 * caller passes as `failedAt` (unknown → the first unfinished phase).
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
  const current = phase === "failed" ? (failedAt ?? "verifying") : phase;
  const idx = steps.findIndex((s) => s.phase === current);
  const fixPhases: RunPhase[] = ["fixing", "waiting-preview", "retesting", "comparing"];

  return (
    <ol className="flex w-full flex-wrap items-center gap-y-2" aria-label="Pipeline phase">
      {steps.map((s, i) => {
        const skipped = phase === "done" && !hasFix && fixPhases.includes(s.phase);
        const done = !skipped && (phase === "done" ? true : i < idx);
        const active = phase !== "done" && i === idx;
        const failed = phase === "failed" && i === idx;
        return (
          <li key={s.phase} className="flex flex-1 items-center gap-2 last:flex-none" aria-current={active ? "step" : undefined}>
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
            {i < steps.length - 1 && <span className={cn("mx-2 h-px min-w-4 flex-1", done ? "bg-primary" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}
