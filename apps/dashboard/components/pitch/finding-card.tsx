"use client";

import { GitCommitVertical, MousePointerClick, TriangleAlert, Users } from "lucide-react";
import type { Finding } from "@frictionswarm/shared";
import { compact, pct, segmentColor } from "@/lib/format";
import { segmentEs as segmentShort, shortDateEs as shortDate } from "./es";
import { cn } from "@/lib/utils";
import { Dot } from "./parts";

/** One finding, sized for the projector: trap title, segments, evidence counts, introducing release. */
export function PitchFindingCard({
  f,
  rank,
  compactTitle,
  minimal,
  className,
}: {
  f: Finding;
  rank?: number;
  compactTitle?: boolean;
  /** Id, segments and title only: no severity or evidence counts. */
  minimal?: boolean;
  className?: string;
}) {
  const e = f.evidence;
  if (minimal)
    return (
      <article className={cn("flex flex-col gap-3 rounded-2xl border bg-card p-6", className)}>
        <div className="flex items-center gap-3 text-lg">
          <span className="rounded-md border px-2 py-0.5 font-mono text-base">{f.id}</span>
          {f.segments.map((s) => (
            <span key={s} className="flex items-center gap-2 whitespace-nowrap">
              <Dot color={segmentColor(s)} />
              {segmentShort(s)}
            </span>
          ))}
        </div>
        <h3 className="text-2xl leading-snug font-semibold text-pretty">{f.title}</h3>
      </article>
    );
  return (
    <article className={cn("flex h-full flex-col rounded-2xl border bg-card", compactTitle ? "gap-3 p-5" : "gap-4 p-6", className)}>
      <div className="flex items-center gap-3 text-lg">
        {rank !== undefined && <span className="tabular text-3xl font-semibold text-muted-foreground">#{rank}</span>}
        <span className="rounded-md border px-2 py-0.5 font-mono text-base">{f.id}</span>
        {f.segments.map((s) => (
          <span key={s} className="flex items-center gap-2 rounded-full border px-3 py-0.5 whitespace-nowrap">
            <Dot color={segmentColor(s)} />
            {segmentShort(s)}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <TriangleAlert className="size-5" style={{ color: f.severity === "high" ? "var(--status-critical)" : "var(--status-warning)" }} aria-hidden />
          {f.severity}
        </span>
      </div>
      <h3 className={cn("leading-snug font-semibold text-pretty", compactTitle ? "text-xl" : "text-2xl")}>{f.title}</h3>
      <div className={cn("mt-auto flex flex-col gap-1.5", compactTitle ? "text-lg" : "text-xl")}>
        <div className="tabular flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
          <span className="flex items-center gap-2">
            <Users className="size-5" aria-hidden />
            <span className="font-semibold text-foreground">{compact(e.sessions)}</span> sesiones
          </span>
          {e.rageClicks ? (
            <span className="flex items-center gap-2">
              <MousePointerClick className="size-5" aria-hidden />
              <span className="font-semibold text-foreground">{compact(e.rageClicks)}</span> rage clicks
            </span>
          ) : null}
          {e.dropOffRate !== undefined && (
            <span>
              <span className="font-semibold text-foreground">{pct(e.dropOffRate)}</span> drop-off
            </span>
          )}
        </div>
        {e.sinceRelease && (
          <span className="flex items-center gap-2">
            <GitCommitVertical className="size-5 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">desde</span>
            <span className="font-semibold">{e.sinceRelease.name}</span>
            <span className="text-muted-foreground">· {shortDate(e.sinceRelease.date)}</span>
          </span>
        )}
      </div>
    </article>
  );
}
