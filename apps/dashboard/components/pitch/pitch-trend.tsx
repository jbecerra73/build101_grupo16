"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Release, SegmentId, TrendPoint } from "@frictionswarm/shared";
import type { ReleaseImpact } from "@/components/run/trend-chart";
import { pct1, segmentColor, segmentShort } from "@/lib/format";

const SEGMENT_ORDER: SegmentId[] = ["low_vision", "mobile", "desktop"];
const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);

/** Seconds: lines draw in over DRAW, then the breaking releases light up. */
export const DRAW = 1.8;
export const HIGHLIGHT_AT = DRAW + 0.3;

/**
 * Weekly completion per segment for the projector: 3px lines that draw in, a
 * hairline per release, then a ringed dot + bold marker on the release that broke
 * each segment. Same data and impact rule as the run page's TrendChart.
 */
export function PitchTrend({
  points,
  releases,
  impacts,
  width,
  height,
}: {
  points: TrendPoint[];
  releases: Release[];
  impacts: ReleaseImpact[];
  width: number;
  height: number;
}) {
  const reduced = useReducedMotion();
  const m = { top: 64, right: 210, bottom: 44, left: 72 };
  const weeks = [...new Set(points.map((p) => p.weekStart))].sort();
  if (!weeks.length) return <p className="text-2xl text-muted-foreground">No weekly data in this run.</p>;
  const series = SEGMENT_ORDER.map((s) => ({ s, pts: weeks.map((w) => points.find((p) => p.segmentId === s && p.weekStart === w)) })).filter((x) => x.pts.some(Boolean));

  const x0 = t(weeks[0]);
  const x1 = Math.max(t(weeks.at(-1)!), x0 + DAY);
  const yMax = Math.ceil(Math.max(0.05, ...points.map((p) => p.completionRate)) * 10) / 10;
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const X = (ms: number) => m.left + ((ms - x0) / (x1 - x0)) * iw;
  const Y = (r: number) => m.top + ih - (r / yMax) * ih;
  const yTicks = Array.from({ length: Math.round(yMax / 0.1) + 1 }, (_, i) => i * 0.1);
  const months: number[] = [];
  const first = new Date(x0);
  for (let k = 1; ; k++) {
    const ms = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + k, 1);
    if (ms > x1) break;
    months.push(ms);
  }
  const visible = releases.filter((r) => t(r.date) >= x0 - 3 * DAY && t(r.date) <= x1 + 3 * DAY);
  const broke = new Set(impacts.map((i) => i.release.sha));
  const line = (pts: (TrendPoint | undefined)[]) => {
    let d = "";
    let pen = false;
    pts.forEach((p, i) => {
      if (!p) return void (pen = false);
      d += `${pen ? "L" : "M"}${X(t(weeks[i])).toFixed(1)},${Y(p.completionRate).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const hi = (delay: number) => (reduced ? { duration: 0.2 } : { duration: 0.5, delay });

  // End labels, spread at least 30px apart in the lines' order.
  const ends = series
    .map(({ s, pts }) => {
      const i = pts.findLastIndex(Boolean);
      return { s, x: X(t(weeks[i])), y: Y(pts[i]!.completionRate), rate: pts[i]!.completionRate, ly: Y(pts[i]!.completionRate) };
    })
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].ly = Math.max(ends[i].ly, ends[i - 1].ly + 30);

  return (
    <svg width={width} height={height} role="img" aria-label="Weekly checkout completion per segment over six months, with production releases" className="block overflow-visible">
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={m.left} x2={m.left + iw} y1={Y(v)} y2={Y(v)} className="stroke-border" strokeWidth={1} />
          <text x={m.left - 14} y={Y(v)} dy="0.35em" textAnchor="end" className="tabular fill-muted-foreground" fontSize={20}>
            {Math.round(v * 100)}%
          </text>
        </g>
      ))}
      {months.map((ms) => (
        <text key={ms} x={X(ms)} y={height - 8} textAnchor="middle" className="fill-muted-foreground" fontSize={20}>
          {new Date(ms).toLocaleDateString("en", { month: "short", timeZone: "UTC" })}
        </text>
      ))}

      {/* release markers: hairlines first, the breaking ones light up later */}
      {visible.map((r, i) => {
        const rx = X(Math.min(Math.max(t(r.date), x0), x1));
        const isBreak = broke.has(r.sha);
        const ty = m.top - (i % 2 ? 14 : 42);
        return (
          <motion.g key={r.sha} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? { duration: 0.2 } : { duration: 0.4, delay: 0.1 + i * 0.08 }}>
            <line x1={rx} x2={rx} y1={ty + 6} y2={m.top + ih} className="stroke-muted-foreground/50" strokeWidth={1.5} strokeDasharray="4 5" />
            <text x={rx + 6} y={ty} className="fill-muted-foreground" fontSize={19}>
              {r.name}
            </text>
            {isBreak && (
              <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={hi(HIGHLIGHT_AT)}>
                <line x1={rx} x2={rx} y1={ty + 6} y2={m.top + ih} className="stroke-foreground" strokeWidth={2} />
                <rect x={rx + 1} y={ty - 20} width={r.name.length * 10.5 + 12} height={28} rx={6} className="fill-background" />
                <text x={rx + 6} y={ty} className="fill-foreground" fontSize={19} fontWeight={700}>
                  {r.name}
                </text>
              </motion.g>
            )}
          </motion.g>
        );
      })}

      {series.map(({ s, pts }, i) => (
        <motion.path
          key={s}
          d={line(pts)}
          fill="none"
          stroke={segmentColor(s)}
          strokeWidth={3.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          initial={reduced ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: DRAW, delay: 0.25 + i * 0.12, ease: "easeInOut" }}
        />
      ))}

      {/* the release that broke each segment: a ringed dot on its line, the week after it shipped */}
      {impacts.map((imp, k) => {
        const i = weeks.findIndex((w) => t(w) + 3 * DAY >= t(imp.release.date));
        const p = series.find((x) => x.s === imp.segmentId)?.pts[i];
        if (i < 0 || !p) return null;
        const cx = X(t(weeks[i]));
        const cy = Y(p.completionRate);
        return (
          <motion.g
            key={imp.segmentId}
            style={{ transformOrigin: `${cx}px ${cy}px`, transformBox: "view-box" }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 2.4 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={hi(HIGHLIGHT_AT + 0.15 + k * 0.25)}
          >
            <circle cx={cx} cy={cy} r={17} fill="none" stroke={segmentColor(imp.segmentId)} strokeWidth={3} />
            <circle cx={cx} cy={cy} r={8} fill={segmentColor(imp.segmentId)} className="stroke-background" strokeWidth={3} />
          </motion.g>
        );
      })}

      {/* direct end labels */}
      {ends.map((l, i) => (
        <motion.g key={l.s} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? { duration: 0.2 } : { duration: 0.4, delay: 0.25 + DRAW + i * 0.12 }}>
          {Math.abs(l.ly - l.y) > 2 && <line x1={l.x + 4} y1={l.y} x2={l.x + 16} y2={l.ly} className="stroke-muted-foreground/60" strokeWidth={1.5} />}
          <text x={l.x + 20} y={l.ly} dy="0.35em" className="fill-foreground" fontSize={22} fontWeight={600}>
            {segmentShort(l.s)} <tspan className="tabular" fontWeight={400}>{pct1(l.rate)}</tspan>
          </text>
        </motion.g>
      ))}
    </svg>
  );
}
