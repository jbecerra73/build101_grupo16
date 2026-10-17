import {
  CircleCheck,
  CirclePause,
  CircleSlash,
  CircleX,
  GitPullRequest,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { FixStatus, RunPhase, Severity } from "@frictionswarm/shared";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { personaColor, personaShort, phaseLabel } from "@/lib/format";
import type { AgentOutcome } from "@/lib/types";

export function PersonaDot({ id, className }: { id: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: personaColor(id) }}
    />
  );
}

/** Persona identity: colored dot + name in text ink (text never wears the series color). */
export function PersonaBadge({ id, suffix, className }: { id: string; suffix?: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5", className)}>
      <PersonaDot id={id} />
      {personaShort(id)}
      {suffix}
    </Badge>
  );
}

type StatusTone = "good" | "warn" | "bad" | "run" | "muted";

const toneColor: Record<StatusTone, string> = {
  good: "var(--status-good)",
  warn: "var(--status-warning)",
  bad: "var(--status-critical)",
  run: "var(--status-running)",
  muted: "var(--muted-foreground)",
};

/** Status always ships as icon + label; the icon carries the reserved status color. */
export function StatusBadge({
  icon: Icon,
  tone,
  children,
  spin,
  className,
}: {
  icon: LucideIcon;
  tone: StatusTone;
  children: React.ReactNode;
  spin?: boolean;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5", className)}>
      <Icon data-icon="inline-start" className={cn(spin && "animate-spin")} style={{ color: toneColor[tone] }} />
      {children}
    </Badge>
  );
}

export const OUTCOME: Record<AgentOutcome, { label: string; icon: LucideIcon; tone: StatusTone }> = {
  running: { label: "Running", icon: LoaderCircle, tone: "run" },
  success: { label: "Completed", icon: CircleCheck, tone: "good" },
  "gave-up": { label: "Gave up", icon: CircleX, tone: "bad" },
  invalid: { label: "Invalid completion", icon: TriangleAlert, tone: "warn" },
  stopped: { label: "Stopped", icon: CirclePause, tone: "muted" },
};

export function OutcomeBadge({ state, className }: { state: AgentOutcome; className?: string }) {
  const o = OUTCOME[state];
  return (
    <StatusBadge icon={o.icon} tone={o.tone} spin={state === "running"} className={className}>
      {o.label}
    </StatusBadge>
  );
}

export function PhaseBadge({ phase }: { phase: RunPhase }) {
  if (phase === "done") return <StatusBadge icon={CircleCheck} tone="good">Done</StatusBadge>;
  if (phase === "failed") return <StatusBadge icon={CircleX} tone="bad">Failed</StatusBadge>;
  return (
    <StatusBadge icon={LoaderCircle} tone="run" spin>
      {phaseLabel(phase)}
    </StatusBadge>
  );
}

export const FIX_STATUS: Record<FixStatus, { label: string; icon: LucideIcon; tone: StatusTone }> = {
  running: { label: "Coding agent working", icon: LoaderCircle, tone: "run" },
  draft: { label: "Draft PR", icon: GitPullRequest, tone: "muted" },
  retesting: { label: "Retesting", icon: LoaderCircle, tone: "run" },
  ready: { label: "Proven: ready for review", icon: CircleCheck, tone: "good" },
  "not-proven": { label: "Fix attempted, not proven", icon: CircleSlash, tone: "warn" },
  failed: { label: "Fix failed", icon: CircleX, tone: "bad" },
};

export function FixStatusBadge({ status, className }: { status: FixStatus; className?: string }) {
  const s = FIX_STATUS[status];
  return (
    <StatusBadge icon={s.icon} tone={s.tone} spin={status === "running" || status === "retesting"} className={className}>
      {s.label}
    </StatusBadge>
  );
}

const SEVERITY: Record<Severity, { label: string; tone: StatusTone }> = {
  high: { label: "High", tone: "bad" },
  medium: { label: "Medium", tone: "warn" },
  low: { label: "Low", tone: "muted" },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return (
    <StatusBadge icon={severity === "low" ? CircleSlash : TriangleAlert} tone={s.tone}>
      {s.label}
    </StatusBadge>
  );
}

/** "3 / 10" style count with N, in tabular figures. */
export function OfN({ value, n, className }: { value: number; n: number; className?: string }) {
  return (
    <span className={cn("tabular text-muted-foreground", className)}>
      {value}/{n}
    </span>
  );
}
