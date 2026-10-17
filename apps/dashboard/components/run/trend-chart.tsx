"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Release, SegmentId, TrendPoint } from "@frictionswarm/shared";
import { pct1, segmentColor, segmentShort, shortDate } from "@/lib/format";

const SEGMENT_ORDER: SegmentId[] = ["low_vision", "mobile", "desktop"];
const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);

export type ReleaseImpact = {
  segmentId: SegmentId;
  release: Release;
  before: number;
  after: number;
  deltaPts: number;
};

/** Completion per segment for each release's span, weighted by weekly N. */
function rateByRelease(points: TrendPoint[], releases: Release[]) {
  const spans = releases.map((r, i) => ({ r, from: t(r.date), to: releases[i + 1] ? t(releases[i + 1].date) : Infinity }));
  const out = new Map<string, number>();
  for (const seg of SEGMENT_ORDER)
    for (const s of spans) {
      // a week belongs to the release live on most of its days
      const inSpan = points.filter((p) => p.segmentId === seg && t(p.weekStart) + 3 * DAY >= s.from && t(p.weekStart) + 3 * DAY < s.to);
      const n = inSpan.reduce((a, p) => a + p.n, 0);
      if (n) out.set(`${seg}:${s.r.sha}`, inSpan.reduce((a, p) => a + p.completed, 0) / n);
    }
  return out;
}

/** For each segment, the release after which its completion fell the most,
 * relative to where it was (a 10% → 3% fall breaks a segment more than 18% → 12%),
 * counting only falls of at least 1.5 pts. */
export function breakingReleases(points: TrendPoint[], releases: Release[]): ReleaseImpact[] {
  const rates = rateByRelease(points, releases);
  const out: ReleaseImpact[] = [];
  for (const seg of SEGMENT_ORDER) {
    let worst: ReleaseImpact | undefined;
    for (let i = 1; i < releases.length; i++) {
      const before = rates.get(`${seg}:${releases[i - 1].sha}`);
      const after = rates.get(`${seg}:${releases[i].sha}`);
      if (before === undefined || after === undefined) continue;
      const deltaPts = (after - before) * 100;
      const rel = before ? after / before - 1 : 0;
      if (deltaPts <= -1.5 && rel < (worst ? worst.after / worst.before - 1 : 0)) worst = { segmentId: seg, release: releases[i], before, after, deltaPts };
    }
    if (worst) out.push(worst);
  }
  return out;
}

/** End-label positions at least 14px apart, in the lines' vertical order. */
function endLabels<T extends { y: number }>(labels: T[]): (T & { ly: number })[] {
  const sorted = labels.map((l) => ({ ...l, ly: l.y })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) sorted[i].ly = Math.max(sorted[i].ly, sorted[i - 1].ly + 14);
  return sorted;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * Weekly completion per segment (one 2px line each, in its persona's color)
 * with a hairline marker per release. The release that broke a segment gets a
 * ringed dot on that segment's line. Crosshair + tooltip on hover/focus; the
 * table view under the chart holds every number.
 */
export function TrendChart({ points, releases, window }: { points: TrendPoint[]; releases: Release[]; window?: { from: string; to: string } }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const height = 300;
  const m = { top: 40, right: 110, bottom: 28, left: 44 };

  const weeks = useMemo(() => [...new Set(points.map((p) => p.weekStart))].sort(), [points]);
  const series = useMemo(
    () => SEGMENT_ORDER.map((s) => ({ s, pts: weeks.map((w) => points.find((p) => p.segmentId === s && p.weekStart === w)) })).filter((x) => x.pts.some(Boolean)),
    [points, weeks],
  );
  const impacts = useMemo(() => breakingReleases(points, releases), [points, releases]);

  if (!weeks.length) return <p className="text-sm text-muted-foreground">No weekly data in this run.</p>;

  const x0 = t(weeks[0]);
  const x1 = Math.max(t(weeks.at(-1)!), x0 + DAY);
  const max = Math.max(0.05, ...points.map((p) => p.completionRate));
  const yMax = Math.ceil(max * 20) / 20; // round up to 5 pts
  const iw = Math.max(10, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const X = (ms: number) => m.left + ((ms - x0) / (x1 - x0)) * iw;
  const Y = (r: number) => m.top + ih - (r / yMax) * ih;
  const yTicks = Array.from({ length: Math.round(yMax / 0.05) + 1 }, (_, i) => i * 0.05).filter((v, i, a) => a.length <= 6 || i % 2 === 0);
  // Month ticks on the 1st of each month inside the range.
  const months: number[] = [];
  const first = new Date(x0);
  for (let k = 1; ; k++) {
    const ms = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + k, 1);
    if (ms > x1) break;
    months.push(ms);
  }
  const visibleReleases = releases.filter((r) => t(r.date) >= x0 - 3 * DAY && t(r.date) <= x1 + 3 * DAY);
  const brokeAt = (sha: string) => impacts.filter((i) => i.release.sha === sha);
  /** SVG path through the weeks that have data; a missing week lifts the pen. */
  const line = (pts: (TrendPoint | undefined)[]) => {
    let d = "";
    let pen = false;
    pts.forEach((p, i) => {
      if (!p) return void (pen = false);
      d += `${pen ? "L" : "M"}${X(t(weeks[i]))},${Y(p.completionRate)} `;
      pen = true;
    });
    return d;
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ms = x0 + ((e.clientX - box.left) / box.width) * (x1 - x0);
    let best = 0;
    weeks.forEach((w, i) => {
      if (Math.abs(t(w) - ms) < Math.abs(t(weeks[best]) - ms)) best = i;
    });
    setHover(best);
  };
  const hx = hover !== undefined ? X(t(weeks[hover])) : 0;
  const tipLeft = hover !== undefined && hx > width - 220;

  return (
    <div className="flex flex-col gap-3">
      {/* Legend: line keys, text in ink */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        {series.map(({ s }) => (
          <span key={s} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-4 rounded-full" style={{ backgroundColor: segmentColor(s) }} />
            {segmentShort(s)}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span aria-hidden className="inline-block h-3.5 w-px bg-muted-foreground/60" />
          release
        </span>
        {window && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden className="inline-block h-3 w-4 rounded-sm bg-muted" />
            analysis window
          </span>
        )}
      </div>
      <div ref={ref} className="relative w-full">
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label="Weekly completion rate per segment, with release markers" className="block overflow-visible">
            {/* analysis window */}
            {window && (
              <rect
                x={Math.max(m.left, X(t(window.from)))}
                y={m.top}
                width={Math.max(0, Math.min(m.left + iw, X(t(window.to))) - Math.max(m.left, X(t(window.from))))}
                height={ih}
                className="fill-muted"
              />
            )}
            {/* grid + y axis */}
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={m.left} x2={m.left + iw} y1={Y(v)} y2={Y(v)} className="stroke-border" strokeWidth={1} />
                <text x={m.left - 8} y={Y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-xs tabular">
                  {Math.round(v * 100)}%
                </text>
              </g>
            ))}
            {months.map((ms) => (
              <text key={ms} x={X(ms)} y={height - 8} textAnchor="middle" className="fill-muted-foreground text-xs">
                {new Date(ms).toLocaleDateString("en", { month: "short", timeZone: "UTC" })}
              </text>
            ))}
            {/* release markers */}
            {visibleReleases.map((r, i) => {
              const rx = X(Math.min(Math.max(t(r.date), x0), x1));
              const broke = brokeAt(r.sha);
              return (
                <g key={r.sha}>
                  <line x1={rx} x2={rx} y1={m.top - (i % 2 ? 4 : 18)} y2={m.top + ih} className="stroke-muted-foreground/60" strokeWidth={1} />
                  <text x={rx + 4} y={m.top - (i % 2 ? 6 : 20)} className={broke.length ? "fill-foreground text-xs font-semibold" : "fill-muted-foreground text-xs"}>
                    {r.name}
                  </text>
                </g>
              );
            })}
            {/* series */}
            {series.map(({ s, pts }) => (
              <path key={s} d={line(pts)} fill="none" stroke={segmentColor(s)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {/* the release that broke each segment: ringed dot on its line, after the drop */}
            {impacts.map((imp) => {
              const i = weeks.findIndex((w) => t(w) + 3 * DAY >= t(imp.release.date));
              const p = series.find((x) => x.s === imp.segmentId)?.pts[i];
              if (i < 0 || !p) return null;
              return <circle key={imp.segmentId} cx={X(t(weeks[i]))} cy={Y(p.completionRate)} r={5} fill={segmentColor(imp.segmentId)} className="stroke-card" strokeWidth={2} />;
            })}
            {/* direct end labels, spread apart with a leader line when lines converge */}
            {endLabels(series.map(({ s, pts }) => {
              const lastI = pts.findLastIndex(Boolean);
              return { s, x: X(t(weeks[lastI])), y: Y(pts[lastI]!.completionRate), rate: pts[lastI]!.completionRate };
            })).map((l) => (
              <g key={l.s}>
                {Math.abs(l.ly - l.y) > 2 && <line x1={l.x + 2} y1={l.y} x2={l.x + 10} y2={l.ly} className="stroke-muted-foreground/60" strokeWidth={1} />}
                <text x={l.x + 12} y={l.ly} dy="0.32em" className="fill-foreground text-xs font-medium">
                  {segmentShort(l.s)} {pct1(l.rate)}
                </text>
              </g>
            ))}
            {/* crosshair */}
            {hover !== undefined && (
              <g pointerEvents="none">
                <line x1={hx} x2={hx} y1={m.top} y2={m.top + ih} className="stroke-foreground/40" strokeWidth={1} />
                {series.map(({ s, pts }) =>
                  pts[hover] ? <circle key={s} cx={hx} cy={Y(pts[hover]!.completionRate)} r={4} fill={segmentColor(s)} className="stroke-card" strokeWidth={2} /> : null,
                )}
              </g>
            )}
            <rect
              x={m.left}
              y={m.top}
              width={iw}
              height={ih}
              fill="transparent"
              tabIndex={0}
              aria-label="Move to read weekly values"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(undefined)}
              onFocus={() => setHover(weeks.length - 1)}
              onBlur={() => setHover(undefined)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? weeks.length) - 1));
                if (e.key === "ArrowRight") setHover((h) => Math.min(weeks.length - 1, (h ?? -1) + 1));
              }}
              className="outline-none"
            />
          </svg>
        )}
        {hover !== undefined && (
          <div
            className="pointer-events-none absolute top-8 z-10 flex min-w-48 flex-col gap-1 rounded-md border bg-popover px-3 py-2 text-sm shadow-md"
            style={tipLeft ? { right: width - hx + 12 } : { left: hx + 12 }}
          >
            <span className="text-xs text-muted-foreground">Week of {shortDate(weeks[hover])}</span>
            {series.map(({ s, pts }) => {
              const p = pts[hover];
              return (
                <span key={s} className="flex items-center gap-2">
                  <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: segmentColor(s) }} />
                  <span className="tabular font-semibold">{p ? pct1(p.completionRate) : "—"}</span>
                  <span className="text-muted-foreground">
                    {segmentShort(s)} {p ? `· ${p.completed}/${p.n}` : ""}
                  </span>
                </span>
              );
            })}
            {(() => {
              const r = releases.findLast((r) => t(r.date) <= t(weeks[hover]) + 3 * DAY);
              return r ? <span className="text-xs text-muted-foreground">Live: {r.name}</span> : null;
            })()}
          </div>
        )}
      </div>
      {impacts.length > 0 && (
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {impacts.map((imp) => (
            <li key={imp.segmentId} className="flex items-center gap-2">
              <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: segmentColor(imp.segmentId) }} />
              <span>
                <span className="font-medium">{segmentShort(imp.segmentId)}</span> broke with <span className="font-medium">{imp.release.name}</span>{" "}
                <span className="text-muted-foreground">({shortDate(imp.release.date)})</span>:{" "}
                <span className="tabular">
                  {pct1(imp.before)} → {pct1(imp.after)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Table view of the trend: every week, every segment, with N. */
export function TrendTable({ points }: { points: TrendPoint[] }) {
  const weeks = [...new Set(points.map((p) => p.weekStart))].sort();
  const segs = SEGMENT_ORDER.filter((s) => points.some((p) => p.segmentId === s));
  return (
    <div className="max-h-72 overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b">
            <th className="px-3 py-1.5 text-left font-medium">Week of</th>
            {segs.map((s) => (
              <th key={s} className="px-3 py-1.5 text-right font-medium">
                {segmentShort(s)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w} className="border-b last:border-0">
              <td className="px-3 py-1 text-muted-foreground">{shortDate(w)}</td>
              {segs.map((s) => {
                const p = points.find((x) => x.segmentId === s && x.weekStart === w);
                return (
                  <td key={s} className="tabular px-3 py-1 text-right">
                    {p ? (
                      <>
                        {pct1(p.completionRate)} <span className="text-muted-foreground">({p.completed}/{p.n})</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
