"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleX, Play, Radio, Square } from "lucide-react";
import type { Event, RunPhase } from "@frictionswarm/shared";
import { FixStatusBadge, PersonaDot } from "@/components/bits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { deriveAgents, deriveMetrics, giveUpGroups } from "@/lib/derive";
import { formatDateTime, isTerminal, personaShort, shortSha } from "@/lib/format";
import type { RunDetail } from "@/lib/types";
import { FixPanel } from "./fix-panel";
import { LiveGrid } from "./live-grid";
import { PhaseStepper } from "./phase-stepper";
import { ReplayControls } from "./replay-controls";
import { Findings, Funnels, GiveUps, PersonaKpis } from "./report";

const POLL_MS = 1500;

function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function usePolledRun(initial: RunDetail, enabled: boolean) {
  const [run, setRun] = useState(initial);
  const [error, setError] = useState(false);
  const live = enabled && !isTerminal(run.status.phase);
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(initial.runId)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as RunDetail;
        if (!cancelled) {
          setRun(next);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [live, initial.runId]);
  return { run, live, error };
}

function useReplay(events: Event[], enabled: boolean) {
  const t0 = events[0]?.ts ?? 0;
  const length = events.length ? events.at(-1)!.ts - t0 : 0;
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(enabled && events.length > 0);
  const [speed, setSpeed] = useState(4);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !playing) return;
    // A timer (not rAF) so playback also advances in background tabs and headless capture.
    last.current = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      const dt = now - (last.current ?? now);
      last.current = now;
      setPos((p) => Math.min(length, p + dt * speed));
    }, 50);
    return () => {
      clearInterval(t);
      last.current = null;
    };
  }, [enabled, playing, speed, length]);

  useEffect(() => {
    if (playing && pos >= length) setPlaying(false);
  }, [playing, pos, length]);

  const shown = useMemo(() => {
    const cut = t0 + pos;
    let i = 0;
    while (i < events.length && events[i].ts <= cut) i++;
    return i;
  }, [events, pos, t0]);

  return { pos, setPos, playing, setPlaying, speed, setSpeed, length, shown, atEnd: pos >= length };
}

export function RunView({ initial, replay }: { initial: RunDetail; replay: boolean }) {
  const { run, live, error } = usePolledRun(initial, !replay);
  const events = useMemo(() => initial.events ?? [], [initial.events]);
  const r = useReplay(events, replay);

  // What to render: the live/finished run, or the replay cut at the scrubber position.
  const view = useMemo(() => {
    if (!replay || r.atEnd) {
      return {
        agents: run.agents,
        metrics: run.metrics ?? run.provisionalMetrics,
        provisional: !run.metrics,
        findings: run.findings,
        giveUps: run.giveUps,
        themes: run.themes,
        fix: run.fix,
        phase: run.status.phase as RunPhase,
      };
    }
    const partial = events.slice(0, r.shown);
    return {
      agents: deriveAgents(run.config, partial, run.flow, true),
      metrics: deriveMetrics(run.config, partial, run.flow),
      provisional: true,
      findings: undefined,
      giveUps: giveUpGroups(partial),
      themes: undefined,
      fix: undefined,
      phase: "swarming" as RunPhase,
    };
  }, [replay, r.atEnd, r.shown, run, events]);

  const { config, status, flow } = run;
  const latestFix = run.fix?.attempts.at(-1);
  const nTotal = run.agents.length;
  const fixedIds = new Map((view.fix?.attempts ?? []).flatMap((a) => a.findingIds.map((id) => [id, `attempt ${a.attempt}`] as const)));
  const fixPhase = ["fixing", "waiting-preview", "retesting", "comparing"].includes(view.phase);
  const failedAt = status.phase === "failed" ? (run.metrics ? "fixing" : run.agents.some((a) => a.actions) ? "swarming" : "verifying") : undefined;
  // A finished run with a fix leads with its outcome: before/after + PR, then the report, then the grid.
  const fixFirst = !replay && status.phase === "done" && !!run.fix;
  const showFix = !!view.fix || fixPhase;

  const agentsSection = (
    <Section
      key="agents"
      id="agents"
      title="Agents"
      aside={
        view.phase === "swarming" && (
          <Badge variant="outline">
            <Spinner data-icon="inline-start" />
            swarming
          </Badge>
        )
      }
    >
      {view.agents.length ? (
        <LiveGrid runId={config.runId} agents={view.agents} />
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>Agents appear once the build is verified and the swarm starts.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Section>
  );

  const reportSection = (
    <Section
      key="report"
      id="report"
      title="Report"
      aside={
        view.provisional && view.metrics ? (
          <Badge variant="outline">Provisional · computed from events so far</Badge>
        ) : view.metrics ? (
          <Badge variant="secondary">Analyzer metrics</Badge>
        ) : null
      }
    >
      {view.metrics ? (
        <div className="flex flex-col gap-8">
          <PersonaKpis metrics={view.metrics} />
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Funnel by persona</h3>
            <p className="-mt-2 text-sm text-muted-foreground">Bar = agents that reached the step, out of N. Lock = required step.</p>
            <Card>
              <CardContent>
                <Funnels metrics={view.metrics} flow={flow} />
              </CardContent>
            </Card>
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Friction hotspots</h3>
            {view.findings ? (
              <Findings findings={view.findings} runId={config.runId} fixedIds={fixedIds} />
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">Ranked findings appear after the analyzer pass.</p>
                <Skeleton className="h-28 w-full" />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Why agents gave up</h3>
            {view.themes?.length ? (
              <p className="-mt-2 text-sm text-muted-foreground">Give-up reasons grouped into themes by the analyzer, with the agents&apos; own words.</p>
            ) : null}
            <GiveUps groups={view.giveUps} themes={view.themes} />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      )}
    </Section>
  );

  const fixSection = showFix && (
    <Section key="fix" id="fix" title="Fix & before/after">
      {view.fix ? (
        <FixPanel fix={view.fix} findings={run.findings ?? []} />
      ) : (
        <Card>
          <CardContent className="flex items-center gap-3">
            <Spinner />
            <span>The coding agent is preparing a fix for the top findings…</span>
          </CardContent>
        </Card>
      )}
    </Section>
  );

  const sections = fixFirst ? [fixSection, reportSection, agentsSection] : [agentsSection, reportSection, fixSection];
  const navItems: [string, string][] = [
    ["agents", "Agents"],
    ["report", "Report"],
    ...(showFix ? ([["fix", "Fix & retest"]] as [string, string][]) : []),
  ];
  if (fixFirst) navItems.reverse();

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <nav className="text-sm text-muted-foreground">
              <Link href="/" className="hover:underline">
                Runs
              </Link>{" "}
              / <span className="font-mono">{config.runId}</span>
            </nav>
            <h1 className="text-3xl font-semibold tracking-tight">{flow?.goal ?? config.flowId}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <Badge variant={config.kind === "retest" ? "secondary" : "outline"}>{config.kind}</Badge>
              <span>
                Build <code className="font-mono text-foreground">{shortSha(config.buildSha)}</code>
              </span>
              <span className="truncate">
                Target <code className="font-mono text-foreground">{config.targetUrl.replace(/^https?:\/\//, "")}</code>
              </span>
              <span className="tabular">
                N=<span className="text-foreground">{nTotal}</span> agents
              </span>
              <span className="flex items-center gap-3">
                {config.personaIds.map((p) => (
                  <span key={p} className="flex items-center gap-1.5">
                    <PersonaDot id={p} />
                    {personaShort(p)} <span className="tabular text-foreground">×{config.seeds[p]?.length ?? 0}</span>
                  </span>
                ))}
              </span>
              <span>{formatDateTime(config.createdAt)}</span>
              {config.baselineRunId && (
                <Link className="underline underline-offset-4" href={`/runs/${config.baselineRunId}`}>
                  Baseline: {config.baselineRunId}
                </Link>
              )}
              {status.retestRunId && (
                <Link className="underline underline-offset-4" href={`/runs/${status.retestRunId}`}>
                  Retest: {status.retestRunId}
                </Link>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {replay ? (
              <Button variant="outline" asChild>
                <Link href={`/runs/${config.runId}`}>
                  <Square data-icon="inline-start" />
                  Exit replay
                </Link>
              </Button>
            ) : (
              <Button variant="secondary" asChild>
                <Link href={`/runs/${config.runId}?replay=1`}>
                  <Play data-icon="inline-start" />
                  Replay
                </Link>
              </Button>
            )}
          </div>
        </div>

        <Card size="sm">
          <CardContent className="flex flex-col gap-3">
            <PhaseStepper phase={view.phase} kind={config.kind} hasFix={!!run.fix} failedAt={failedAt} />
            {(status.message || live || error || latestFix) && !replay && (
              <>
                <Separator />
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  {live && (
                    <span className="flex items-center gap-1.5 font-medium">
                      <Radio className="size-4 animate-pulse" style={{ color: "var(--status-running)" }} aria-hidden />
                      Live
                    </span>
                  )}
                  {status.message && <span>{status.message}</span>}
                  {latestFix && (
                    <span className="ml-auto flex items-center gap-2">
                      <FixStatusBadge status={latestFix.status} />
                      <Button variant="link" size="sm" asChild>
                        <a href="#fix">See before/after</a>
                      </Button>
                    </span>
                  )}
                  {error && <span className="text-destructive">Lost connection to the dashboard server, retrying…</span>}
                  {status.inferred && <span className="text-muted-foreground">(phase inferred from files)</span>}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {status.phase === "failed" && (
          <Alert variant="destructive">
            <CircleX />
            <AlertTitle>Run failed</AlertTitle>
            <AlertDescription>{status.error ?? status.message ?? "The orchestrator reported a failure."}</AlertDescription>
          </Alert>
        )}

        {replay &&
          (events.length ? (
            <ReplayControls
              playing={r.playing}
              onPlayingChange={r.setPlaying}
              speed={r.speed}
              onSpeedChange={r.setSpeed}
              position={r.pos}
              length={r.length}
              onSeek={r.setPos}
              eventsShown={r.shown}
              eventsTotal={events.length}
            />
          ) : (
            <Alert>
              <AlertTitle>Nothing to replay</AlertTitle>
              <AlertDescription>This run has no events yet.</AlertDescription>
            </Alert>
          ))}

        <nav className="flex gap-1 text-sm" aria-label="Sections">
          {navItems.map(([id, label]) => (
            <Button key={id} variant="ghost" size="sm" asChild>
              <a href={`#${id}`}>{label}</a>
            </Button>
          ))}
        </nav>
      </div>

      {sections}
    </div>
  );
}
