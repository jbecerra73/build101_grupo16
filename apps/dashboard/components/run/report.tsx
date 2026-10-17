"use client";

import { CircleX, Lock, MousePointerClick, Quote, Users, Wrench } from "lucide-react";
import type { Finding, Flow, Metrics, PersonaMetrics, Severity } from "@frictionswarm/shared";
import { PersonaBadge, PersonaDot, SeverityBadge } from "@/components/bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { GiveUpGroup } from "@/lib/derive";
import { duration, pct, personaColor, personaShort } from "@/lib/format";
import { cn } from "@/lib/utils";
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

function PersonaKpi({ m }: { m: PersonaMetrics }) {
  const noValid = m.completed === 0;
  return (
    <Card className="border-t-4" style={{ borderTopColor: personaColor(m.personaId) }}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PersonaDot id={m.personaId} className="size-3" />
          {personaShort(m.personaId)}
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

function FunnelChart({ m, required }: { m: PersonaMetrics; required: Set<string> }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 font-medium">
        <PersonaDot id={m.personaId} className="size-3" />
        {personaShort(m.personaId)}
        <span className="tabular text-sm font-normal text-muted-foreground">N={m.n}</span>
      </div>
      <ol className="flex flex-col gap-1.5">
        {m.funnel.map((s) => {
          const frac = m.n ? s.reached / m.n : 0;
          return (
            <Tooltip key={s.step}>
              <TooltipTrigger asChild>
                <li className="grid grid-cols-[7rem_1fr_2.75rem_4rem] items-center gap-2 rounded-sm py-0.5 hover:bg-muted/60" tabIndex={0}>
                  <span className="flex items-center gap-1 truncate text-sm">
                    {required.has(s.step) && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="required step" />}
                    {s.step}
                  </span>
                  <span className="relative h-5 border-l border-[color:var(--border)]">
                    {s.reached > 0 && (
                      <span
                        className="absolute inset-y-0 left-0 rounded-r-[4px] transition-[width] duration-500"
                        style={{ width: `${frac * 100}%`, backgroundColor: personaColor(m.personaId) }}
                      />
                    )}
                  </span>
                  <span className="tabular text-right text-sm text-muted-foreground">
                    {s.reached}/{m.n}
                  </span>
                  <span className="flex items-center gap-1 text-sm font-medium whitespace-nowrap">
                    {s.droppedHere > 0 && (
                      <>
                        <CircleX className="size-3.5 shrink-0" style={{ color: "var(--status-critical)" }} aria-hidden />
                        <span className="tabular">{s.droppedHere}</span> left
                      </>
                    )}
                  </span>
                </li>
              </TooltipTrigger>
              <TooltipContent side="top">
                {s.step}: {s.reached} of {m.n} reached{s.droppedHere ? `, ${s.droppedHere} dropped here` : ""}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </ol>
    </div>
  );
}

export function Funnels({ metrics, flow }: { metrics: Metrics; flow?: Flow }) {
  const required = new Set(flow?.required.steps ?? []);
  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
      {metrics.personas.map((m) => (
        <FunnelChart key={m.personaId} m={m} required={required} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- Findings */

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const rankFindings = (fs: Finding[]) =>
  [...fs].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.evidence.agentCount - a.evidence.agentCount);

function FindingCard({ f, rank, runId, fixedBy }: { f: Finding; rank: number; runId: string; fixedBy?: string }) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-4 md:grid-cols-[200px_1fr]">
        <div className="flex flex-col gap-2">
          {f.evidence.screenshots.length > 0 ? (
            <ShotDialog
              runId={runId}
              path={f.evidence.screenshots[0]}
              title={f.title}
              description={`${f.step} · ${f.page}${f.selector ? ` · ${f.selector}` : ""}`}
              className="aspect-[16/10] w-full"
            >
              {f.evidence.quotes.map((q) => (
                <blockquote key={q} className="border-l-2 pl-3 italic">
                  “{q}”
                </blockquote>
              ))}
            </ShotDialog>
          ) : (
            <div className="flex aspect-[16/10] items-center justify-center rounded-md bg-muted text-sm text-muted-foreground">No screenshot</div>
          )}
          {f.evidence.screenshots.length > 1 && (
            <div className="flex gap-1.5">
              {f.evidence.screenshots.slice(1, 4).map((s) => (
                <ShotDialog key={s} runId={runId} path={s} title={f.title} className="aspect-[16/10] w-1/3" />
              ))}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <span className="tabular text-2xl font-semibold text-muted-foreground">#{rank}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h4 className="text-lg leading-snug font-semibold">{f.title}</h4>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <SeverityBadge severity={f.severity} />
                {f.personas.map((p) => (
                  <PersonaBadge key={p} id={p} />
                ))}
                <Badge variant="outline">
                  <Users data-icon="inline-start" />
                  <span className="tabular">{f.evidence.agentCount}</span> agent{f.evidence.agentCount === 1 ? "" : "s"}
                </Badge>
                {fixedBy && <Badge variant="secondary">Targeted by fix {fixedBy}</Badge>}
              </div>
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Step</dt>
            <dd>
              {f.step} <span className="text-muted-foreground">·</span> <code className="font-mono">{f.page}</code>
            </dd>
            {f.selector && (
              <>
                <dt className="text-muted-foreground">Selector</dt>
                <dd className="flex min-w-0 items-center gap-1.5">
                  <MousePointerClick className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <code className="truncate font-mono">{f.selector}</code>
                </dd>
              </>
            )}
          </dl>
          {f.evidence.quotes.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {f.evidence.quotes.slice(0, 3).map((q) => (
                <blockquote key={q} className="flex gap-2 text-base">
                  <Quote className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="italic">{q}</span>
                </blockquote>
              ))}
            </div>
          )}
          <p className="flex gap-2 rounded-md bg-muted px-3 py-2 text-sm">
            <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              <span className="font-medium">Suggested fix: </span>
              {f.suggestedFix}
            </span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function Findings({ findings, runId, fixedIds }: { findings: Finding[]; runId: string; fixedIds: Map<string, string> }) {
  if (!findings.length) return <p className="text-muted-foreground">No findings.</p>;
  return (
    <div className="flex flex-col gap-3">
      {rankFindings(findings).map((f, i) => (
        <FindingCard key={f.id} f={f} rank={i + 1} runId={runId} fixedBy={fixedIds.get(f.id)} />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- Give-ups */

export function GiveUps({ groups }: { groups: GiveUpGroup[] }) {
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
                <blockquote key={q.agentId} className={cn("flex gap-2 border-l-4 pl-3")} style={{ borderLeftColor: personaColor(q.personaId) }}>
                  <span className="flex flex-col">
                    <span className="italic">“{q.note}”</span>
                    <span className="text-xs text-muted-foreground">
                      {personaShort(q.personaId)} · {q.agentId}
                    </span>
                  </span>
                </blockquote>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
