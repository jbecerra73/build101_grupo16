"use client";

import { CircleX, ExternalLink, GitCommitHorizontal, Lock, MousePointerClick, MousePointer2, Quote, Users, Wrench } from "lucide-react";
import type { Finding, Flow, FunnelStep, Metrics, PersonaMetrics, SegmentMetrics, Severity } from "@frictionswarm/shared";
import { PersonaBadge, SeverityBadge } from "@/components/bits";
import { PersonaAvatar } from "@/components/persona/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { GiveUpGroup } from "@/lib/derive";
import { compact, duration, pct, pct1, personaColor, personaShort, segmentColor, segmentName, segmentPersona, segmentShort, shortDate, shortSha } from "@/lib/format";
import type { Theme } from "@/lib/types";
import { ShotDialog } from "./screenshot";

/* ------------------------------------------------------------------ KPIs */

function MiniStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

/** "Rosa stands in for this segment on the re-test." */
function StandIn({ personaId }: { personaId: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>
          <PersonaBadge id={personaId} suffix={<span className="text-muted-foreground">stands in</span>} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{personaShort(personaId)} is the swarm persona that re-tests fixes for this segment.</TooltipContent>
    </Tooltip>
  );
}

function SegmentKpi({ m }: { m: SegmentMetrics }) {
  const personaId = segmentPersona(m.segmentId);
  return (
    <Card className="border-t-4" style={{ borderTopColor: segmentColor(m.segmentId) }}>
      <CardHeader>
        <CardTitle className="text-lg">{segmentShort(m.segmentId)}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <span>{segmentName(m.segmentId)}</span>
          <StandIn personaId={personaId} />
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-baseline gap-3">
          <span className="text-5xl font-semibold tracking-tight">{pct1(m.completionRate)}</span>
          <span className="text-muted-foreground">
            completed <span className="tabular font-medium text-foreground">{compact(m.completed)}/{compact(m.n)}</span>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <MiniStat label="Sessions" value={<span className="tabular">{compact(m.n)}</span>} sub="N" />
          <MiniStat label="Users" value={<span className="tabular">{compact(m.users)}</span>} sub="distinct" />
          <MiniStat label="Median time" value={m.completed ? duration(m.medianTimeMs) : "—"} sub="valid orders" />
          <MiniStat label="Invalid" value={<span className="tabular">{m.invalidCompletions}</span>} sub="failed validity" />
        </div>
      </CardContent>
    </Card>
  );
}

export function SegmentKpis({ metrics }: { metrics: Metrics }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {metrics.segments.map((m) => (
        <SegmentKpi key={m.segmentId} m={m} />
      ))}
    </div>
  );
}

function PersonaKpi({ m }: { m: PersonaMetrics }) {
  const noValid = m.completed === 0;
  return (
    <Card className="border-t-4" style={{ borderTopColor: personaColor(m.personaId) }}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PersonaAvatar personaId={m.personaId} size={40} label="" mood={m.completed === m.n && m.n ? "success" : m.gaveUp ? "gave-up" : "idle"} animate={false} />
          <span className="text-lg">{personaShort(m.personaId)}</span>
          <span className="tabular font-normal text-muted-foreground">N={m.n}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-baseline gap-3">
          <span className="text-5xl font-semibold tracking-tight">{pct(m.completionRate)}</span>
          <span className="text-muted-foreground">
            completed <span className="tabular font-medium text-foreground">{m.completed}/{m.n}</span>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <MiniStat label="Gave up" value={<span className="tabular">{m.gaveUp}/{m.n}</span>} />
          <MiniStat label="Invalid" value={<span className="tabular">{m.invalidCompletions}/{m.n}</span>} />
          <MiniStat label="Median steps" value={noValid ? "—" : m.medianSteps} sub="valid completions" />
          <MiniStat label="Median time" value={noValid ? "—" : duration(m.medianTimeMs)} sub="valid completions" />
        </div>
      </CardContent>
    </Card>
  );
}

export function PersonaKpis({ metrics }: { metrics: Metrics }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {metrics.personas.map((m) => (
        <PersonaKpi key={m.personaId} m={m} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Funnel */

type Group = { key: string; label: React.ReactNode; color: string; n: number; funnel: FunnelStep[] };

function FunnelChart({ g, required }: { g: Group; required: Set<string> }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 font-medium">
        {g.label}
        <span className="tabular text-sm font-normal text-muted-foreground">N={compact(g.n)}</span>
      </div>
      <ol className="flex flex-col gap-1.5">
        {g.funnel.map((s) => {
          const frac = g.n ? s.reached / g.n : 0;
          return (
            <Tooltip key={s.step}>
              <TooltipTrigger asChild>
                <li className="grid grid-cols-[6.5rem_1fr_4.5rem_4.5rem] items-center gap-2 rounded-sm py-0.5 hover:bg-muted/60" tabIndex={0}>
                  <span className="flex items-center gap-1 truncate text-sm">
                    {required.has(s.step) && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="required step" />}
                    {s.step}
                  </span>
                  <span className="relative h-5 border-l border-[color:var(--border)]">
                    {s.reached > 0 && (
                      <span
                        className="absolute inset-y-0 left-0 rounded-r-[4px] transition-[width] duration-500"
                        style={{ width: `max(2px, ${frac * 100}%)`, backgroundColor: g.color }}
                      />
                    )}
                  </span>
                  <span className="tabular text-right text-sm text-muted-foreground">{pct1(frac)}</span>
                  <span className="flex items-center gap-1 text-sm font-medium whitespace-nowrap">
                    {s.droppedHere > 0 && (
                      <>
                        <CircleX className="size-3.5 shrink-0" style={{ color: "var(--status-critical)" }} aria-hidden />
                        <span className="tabular">{compact(s.droppedHere)}</span>
                      </>
                    )}
                  </span>
                </li>
              </TooltipTrigger>
              <TooltipContent side="top">
                {s.step}: {s.reached} of {g.n} reached ({pct1(frac)}){s.droppedHere ? `, ${s.droppedHere} left here` : ""}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </ol>
    </div>
  );
}

/** One funnel per segment (analysis) or per persona (retest). */
export function Funnels({ metrics, flow }: { metrics: Metrics; flow?: Flow }) {
  const required = new Set(flow?.required.steps ?? []);
  const groups: Group[] = metrics.segments.length
    ? metrics.segments.map((m) => ({
        key: m.segmentId,
        label: (
          <>
            <span aria-hidden className="inline-block size-3 rounded-full" style={{ backgroundColor: segmentColor(m.segmentId) }} />
            {segmentShort(m.segmentId)}
          </>
        ),
        color: segmentColor(m.segmentId),
        n: m.n,
        funnel: m.funnel,
      }))
    : metrics.personas.map((m) => ({
        key: m.personaId,
        label: (
          <>
            <PersonaAvatar personaId={m.personaId} size={28} label="" animate={false} />
            {personaShort(m.personaId)}
          </>
        ),
        color: personaColor(m.personaId),
        n: m.n,
        funnel: m.funnel,
      }));
  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
      {groups.map((g) => (
        <FunnelChart key={g.key} g={g} required={required} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- Findings */

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const rankFindings = (fs: Finding[]) =>
  [...fs].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.evidence.sessions - a.evidence.sessions);

function SessionLink({ id, replayBase }: { id: string; replayBase?: string }) {
  const label = <code className="font-mono text-xs">{id.slice(0, 13)}…</code>;
  return replayBase ? (
    <a href={`${replayBase}${encodeURIComponent(id)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4" title={id}>
      {label}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  ) : (
    <span title={id}>{label}</span>
  );
}

function FindingCard({ f, rank, runId, fixedBy, segmentN, replayBase }: { f: Finding; rank: number; runId: string; fixedBy?: string; segmentN?: number; replayBase?: string }) {
  const e = f.evidence;
  const shots = e.screenshots ?? [];
  return (
    <Card size="sm" id={`finding-${f.id}`} className="scroll-mt-20">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <span className="tabular text-2xl font-semibold text-muted-foreground">#{rank}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h4 className="text-lg leading-snug font-semibold">{f.title}</h4>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <SeverityBadge severity={f.severity} />
              {f.segments.map((s) => (
                <Badge key={s} variant="outline" className="gap-1.5">
                  <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: segmentColor(s) }} />
                  {segmentShort(s)}
                </Badge>
              ))}
              {fixedBy && <Badge variant="secondary">Targeted by fix {fixedBy}</Badge>}
            </div>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <dl className="grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Affected</dt>
            <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1">
                <Users className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="tabular font-semibold">{compact(e.sessions)}</span> sessions
                {segmentN ? <span className="tabular text-muted-foreground">of {compact(segmentN)}</span> : null}
              </span>
              <span className="tabular text-muted-foreground">{compact(e.users)} users</span>
              {e.dropOffRate !== undefined && <span className="tabular">{pct(e.dropOffRate)} drop-off</span>}
              {e.rageClicks ? (
                <span className="inline-flex items-center gap-1 tabular">
                  <MousePointer2 className="size-3.5 text-muted-foreground" aria-hidden />
                  {compact(e.rageClicks)} rage clicks
                </span>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">Since</dt>
            <dd>
              {e.sinceRelease ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <GitCommitHorizontal className="size-4 text-muted-foreground" aria-hidden />
                  <span className="font-medium">{e.sinceRelease.name}</span>
                  <span className="text-muted-foreground">
                    {shortDate(e.sinceRelease.date)} · <code className="font-mono">{shortSha(e.sinceRelease.sha)}</code>
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">No single release</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Where</dt>
            <dd>
              {f.step} <span className="text-muted-foreground">·</span> <code className="font-mono">{f.page}</code>
            </dd>
            {f.selector && (
              <>
                <dt className="text-muted-foreground">Selector</dt>
                <dd className="flex min-w-0 items-center gap-1.5">
                  <MousePointerClick className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <code className="truncate font-mono" title={f.selector}>
                    {f.selector}
                  </code>
                </dd>
              </>
            )}
            {e.exampleSessions.length > 0 && (
              <>
                <dt className="text-muted-foreground">Sessions</dt>
                <dd className="flex flex-wrap gap-x-3 gap-y-1">
                  {e.exampleSessions.slice(0, 3).map((id) => (
                    <SessionLink key={id} id={id} replayBase={replayBase} />
                  ))}
                </dd>
              </>
            )}
          </dl>
          <div className="flex flex-col gap-2">
            {e.quotes.slice(0, 2).map((q) => (
              <blockquote key={q} className="flex gap-2 text-base">
                <Quote className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="italic">{q}</span>
              </blockquote>
            ))}
            {shots.length > 0 && (
              <ShotDialog runId={runId} path={shots[0]} title={f.title} description={`${f.step} · ${f.page}`} className="aspect-[16/10] w-48" />
            )}
            <p className="flex gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="font-medium">Suggested fix: </span>
                {f.suggestedFix}
              </span>
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function Findings({
  findings,
  runId,
  fixedIds,
  metrics,
  replayBase,
}: {
  findings: Finding[];
  runId: string;
  fixedIds: Map<string, string>;
  metrics?: Metrics;
  replayBase?: string;
}) {
  if (!findings.length) return <p className="text-muted-foreground">No findings.</p>;
  const nOf = (f: Finding) => metrics?.segments.filter((s) => f.segments.includes(s.segmentId)).reduce((a, s) => a + s.n, 0);
  return (
    <div className="flex flex-col gap-3">
      {rankFindings(findings).map((f, i) => (
        <FindingCard key={f.id} f={f} rank={i + 1} runId={runId} fixedBy={fixedIds.get(f.id)} segmentN={nOf(f) || undefined} replayBase={replayBase} />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- Themes */

function QuoteLine({ personaId, who, text }: { personaId?: string; who: string; text: string }) {
  return (
    <blockquote className="flex items-start gap-2.5 border-l-4 pl-3" style={{ borderLeftColor: personaId ? personaColor(personaId) : "var(--border)" }}>
      {personaId && <PersonaAvatar personaId={personaId} size={30} mood="gave-up" label="" animate={false} className="mt-0.5" />}
      <span className="flex flex-col">
        <span className="italic">“{text}”</span>
        <span className="text-xs text-muted-foreground">{who}</span>
      </span>
    </blockquote>
  );
}

/** Analyzer themes (themes.json): why people or agents left, with verbatim quotes and the findings they map to. */
export function ThemeCards({ themes, unit }: { themes: Theme[]; unit: "session" | "agent" }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {themes.map((t) => {
        const count = t.sessions ?? t.agentCount ?? t.sessionCount;
        return (
          <Card key={t.id} size="sm">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base">
                {t.title}
                {count !== undefined && (
                  <span className="tabular font-normal text-muted-foreground">
                    {compact(count)} {unit}
                    {count === 1 ? "" : "s"}
                  </span>
                )}
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-1.5">
                {t.segments?.map((s) => (
                  <Badge key={s} variant="outline" className="gap-1.5">
                    <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: segmentColor(s) }} />
                    {segmentShort(s)}
                  </Badge>
                ))}
                {t.personas?.map((p) => (
                  <PersonaBadge key={p} id={p} />
                ))}
                {t.findingIds?.map((id) => (
                  <Badge key={id} variant="secondary" asChild>
                    <a href={`#finding-${id}`}>Finding {id}</a>
                  </Badge>
                ))}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {t.quotes.length ? (
                t.quotes.slice(0, 3).map((q) => (
                  <QuoteLine
                    key={`${q.agentId ?? q.sessionId}:${q.text}`}
                    personaId={q.personaId}
                    who={q.agentId ? `${personaShort(q.personaId ?? "")} · ${q.agentId}` : q.sessionId ? `session ${q.sessionId.slice(0, 13)}…` : ""}
                    text={q.text}
                  />
                ))
              ) : unit === "agent" ? (
                <p className="text-sm text-muted-foreground">No quote recorded.</p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** Retest give-ups: the analyzer's themes when themes.json exists, else swarm_give_up reasons by step. */
export function GiveUps({ groups, themes }: { groups: GiveUpGroup[]; themes?: Theme[] }) {
  if (themes?.length) return <ThemeCards themes={themes} unit="agent" />;
  if (!groups.length) return <p className="text-muted-foreground">No agent gave up.</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {groups.map((g) => {
        const personas = [...new Set(g.quotes.map((q) => q.personaId))];
        return (
          <Card key={g.step} size="sm">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                Left at {g.step}
                <span className="tabular font-normal text-muted-foreground">
                  {g.quotes.length} agent{g.quotes.length === 1 ? "" : "s"}
                </span>
              </CardTitle>
              <CardDescription className="flex flex-wrap gap-1.5">
                {personas.map((p) => (
                  <PersonaBadge key={p} id={p} suffix={<span className="tabular text-muted-foreground">{g.quotes.filter((q) => q.personaId === p).length}</span>} />
                ))}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {g.quotes.map((q) => (
                <QuoteLine key={q.agentId} personaId={q.personaId} who={`${personaShort(q.personaId)} · ${q.agentId}`} text={q.note} />
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
