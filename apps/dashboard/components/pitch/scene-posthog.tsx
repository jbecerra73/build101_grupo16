"use client";

import { compact, pct1, segmentColor } from "@/lib/format";
import { segmentEs, shortDateEs } from "./es";
import type { PitchData } from "./data";
import { Dot, FitBox, Reveal, SceneHeader } from "./parts";
import { HIGHLIGHT_AT, PitchTrend } from "./pitch-trend";

const SUMMARY_AT = HIGHLIGHT_AT + 1.4;

export function ScenePostHog({ d, index }: { d: PitchData; index: number }) {
  const trend = d.run.metrics?.trend;
  const sessions = d.run.metrics?.segments.reduce((n, s) => n + s.n, 0) ?? 0;
  const weeks = new Set(trend?.points.map((p) => p.weekStart)).size;

  return (
    <div className="flex h-full flex-col gap-5">
      <SceneHeader
        index={index}
        kicker="Seis meses de PostHog · solo usuarios reales"
        title="¿Qué release empeoró el funnel de ventas?"
        aside={
          <span className="tabular text-2xl text-muted-foreground">
            N = <span className="font-semibold text-foreground">{compact(sessions)}</span> sesiones · {weeks} semanas
          </span>
        }
      />

      <FitBox className="flex-1" innerClassName="gap-5">
      <div className="flex gap-10">
        <div className="flex flex-col gap-3">
          <Reveal delay={0.2} y={0} className="flex items-center gap-8 text-xl">
            {(["low_vision", "mobile", "desktop"] as const).map((s) => (
              <span key={s} className="flex items-center gap-2.5">
                <span aria-hidden className="inline-block h-1 w-7 rounded-full" style={{ backgroundColor: segmentColor(s) }} />
                {segmentEs(s)}
              </span>
            ))}
            <span className="flex items-center gap-2.5 text-muted-foreground">
              <span aria-hidden className="inline-block h-6 border-l-2 border-dashed border-muted-foreground/60" />
              release a producción
            </span>
          </Reveal>
          {trend ? <PitchTrend points={trend.points} releases={trend.releases} impacts={d.impacts} width={1210} height={430} /> : <p className="text-2xl text-muted-foreground">Este run no tiene datos de tendencia.</p>}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4 pt-16">
          <Reveal delay={HIGHLIGHT_AT} y={0}>
            <span className="text-xl tracking-wide text-muted-foreground uppercase">Se rompió con · completion</span>
          </Reveal>
          <ul className="flex flex-col gap-4">
            {d.impacts.map((imp, k) => (
              <Reveal key={imp.segmentId} as="li" delay={HIGHLIGHT_AT + 0.15 + k * 0.25} x={24} y={0} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2.5 text-2xl font-semibold whitespace-nowrap">
                  <Dot color={segmentColor(imp.segmentId)} />
                  {segmentEs(imp.segmentId)}
                  <span className="tabular ml-auto font-normal text-muted-foreground">
                    {pct1(imp.before)} → <span className="font-semibold text-foreground">{pct1(imp.after)}</span>
                  </span>
                </span>
                <span className="text-xl">
                  {imp.release.name} <span className="text-muted-foreground">· {shortDateEs(imp.release.date)}</span>
                </span>
              </Reveal>
            ))}
          </ul>
        </div>
      </div>

      <Reveal delay={SUMMARY_AT} className="mt-auto text-3xl">
        <span className="font-semibold">{d.findings.length} findings</span>
        <span className="text-muted-foreground">, cada uno ligado al release que lo introdujo.</span>
      </Reveal>
      </FitBox>
    </div>
  );
}
