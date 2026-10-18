"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleX, Cpu, Database, LayoutGrid, Map as MapIcon, Play, Presentation, Radio, Square, Table2 } from "lucide-react";
import type { RunPhase } from "@frictionswarm/shared";
import { FixStatusBadge } from "@/components/bits";
import { PersonaAvatar } from "@/components/persona/avatar";
import { RunId, TimeAgo } from "@/components/run-meta";
import { SwarmMap } from "@/components/swarm/swarm-map";
import { SwarmMonitor } from "@/components/swarm/swarm-monitor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getRun } from "@/lib/client/api";
import { deriveAgents, deriveMetrics, giveUpGroups } from "@/lib/derive";
import { compact, FIX_PHASES, isTerminal, personaShort, RETEST_PHASES, shortSha, windowLabel } from "@/lib/format";
import { usePoll } from "@/lib/hooks/use-poll";
import { useReplay } from "@/lib/hooks/use-replay";
import type { AgentState, RunDetail } from "@/lib/types";
import { FixPanel } from "./fix-panel";
import { LiveGrid } from "./live-grid";
import { PhaseStepper } from "./phase-stepper";
import { ReplayControls } from "./replay-controls";
import { Findings, Funnels, GiveUps, PersonaKpis, SegmentKpis, ThemeCards } from "./report";
import { TrendChart, TrendTable } from "./trend-chart";

const POLL_MS = 1000;

function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function usePolledRun(initial: RunDetail, enabled: boolean) {
  const [run, setRun] = useState(initial);
  const [error, setError] = useState(false);
  // A retest has no status of its own: it is live until its metrics exist.
  const live = enabled && (initial.config.kind === "retest" ? !run.metrics : !isTerminal(run.status.phase));
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getRun(initial.runId);
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

/** The re-test swarm three ways: funnel map, sandboxes, agent screens. */
function SwarmTabs({ run, agents, live, derived }: { run: RunDetail; agents: AgentState[]; live: boolean; derived?: boolean }) {
  const metrics = run.metrics ?? run.provisionalMetrics;
  return (
    <Tabs defaultValue="grid" className="gap-4">
      <TabsList variant="line" className="h-10">
        <TabsTrigger value="grid" className="px-3 text-base">
          <LayoutGrid data-icon="inline-start" />
          Agent screens
        </TabsTrigger>
        <TabsTrigger value="map" className="px-3 text-base">
          <MapIcon data-icon="inline-start" />
          Swarm map
        </TabsTrigger>
        <TabsTrigger value="sandboxes" className="px-3 text-base">
          <Cpu data-icon="inline-start" />
          Sandboxes
        </TabsTrigger>
      </TabsList>
      <TabsContent value="grid">
        <LiveGrid runId={run.runId} agents={agents} />
      </TabsContent>
      <TabsContent value="map">
        <Card>
          <CardContent>
            <SwarmMap agents={agents} metrics={metrics} flow={run.flow} live={live} />
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="sandboxes">
        <SwarmMonitor runId={run.runId} agents={agents} live={live} derived={derived} />
      </TabsContent>
    </Tabs>
  );
}

/** Full-screen presenter view of this run (/pitch); a re-test opens its analysis run's pitch. */
function PitchModeButton({ runId }: { runId: string }) {
  return (
    <Button variant="outline" asChild>
      <Link href={`/pitch?run=${encodeURIComponent(runId)}`}>
        <Presentation data-icon="inline-start" />
        Pitch mode
      </Link>
    </Button>
  );
}

function sourceLabel(run: RunDetail) {
  return run.config.posthog.source === "api" ? "PostHog API" : "PostHog export (file)";
}

/* ------------------------------------------------------------ analysis */

function AnalysisView({ initial }: { initial: RunDetail }) {
  const { run, live, error } = usePolledRun(initial, true);
  const { config, status, flow, metrics, findings, fix } = run;
  const phase = status.phase as RunPhase;
  const latestFix = fix?.attempts.at(-1);
  const retestId = status.retestRunId ?? latestFix?.retestRunId;
  const retestLive = RETEST_PHASES.includes(phase) && !!retestId;
  const retest = usePoll(() => getRun(retestId!), POLL_MS, retestLive).data;
  // Only attempt 1 targets this run's findings; retries target their re-test's (same ids, other findings).
  const fixedIds = new Map((fix?.attempts ?? []).filter((a) => a.attempt === 1).flatMap((a) => a.findingIds.map((id) => [id, `attempt ${a.attempt}`] as const)));
  const showFix = !!fix || FIX_PHASES.includes(phase);
  const failedAt: RunPhase | undefined = phase === "failed" ? (latestFix ? (latestFix.retestRunId ? "retesting" : "fixing") : "analyzing") : undefined;
  const release = run.releases?.find((r) => r.sha === config.posthog.buildSha);
  const sessions = metrics?.segments.reduce((n, s) => n + s.n, 0);
  const users = metrics?.segments.reduce((n, s) => n + s.users, 0);

  const retestSection = retestLive && (
    <Section
      key="retest"
      id="retest"
      title="Live re-test on the preview"
      aside={
        <Badge variant="outline">
          <Spinner data-icon="inline-start" />
          {phase === "retesting" ? "swarm running, fresh seeds" : phase === "collecting" ? "waiting for PostHog ingestion" : "comparing"}
        </Badge>
      }
    >
      {retest?.agents.length ? (
        <>
          {phase === "collecting" && (
            <Alert>
              <Database />
              <AlertTitle>Waiting for PostHog ingestion</AlertTitle>
              <AlertDescription>
                The agents are done on screen; their events are still landing in PostHog. Tiles turn final when each agent&apos;s
                swarm_done or swarm_give_up is visible.
              </AlertDescription>
            </Alert>
          )}
          <SwarmTabs run={retest} agents={retest.agents} live />
        </>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-[16/12]" />
          ))}
        </div>
      )}
    </Section>
  );

  const fixSection = showFix && (
    <Section key="fix" id="fix" title="Fix & before/after">
      {fix ? (
        <FixPanel fix={fix} findings={findings ?? []} />
      ) : (
        <Card>
          <CardContent className="flex items-center gap-3">
            <Spinner />
            <span>The coding agent is preparing a fix for the top findings…</span>
          </CardContent>
        </Card>
      )}
      {phase === "done" && latestFix?.retestRunId && (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-base">Re-test swarm</CardTitle>
            <CardDescription>The agents&apos; screens, swarm map and give-up reasons, replayable from the PostHog snapshot.</CardDescription>
            <CardAction className="flex gap-2">
              <Button variant="outline" asChild>
                <Link href={`/runs/${latestFix.retestRunId}`}>
                  Open
                  <ArrowRight data-icon="inline-end" />
                </Link>
              </Button>
              <Button variant="secondary" asChild>
                <Link href={`/runs/${latestFix.retestRunId}?replay=1`}>
                  <Play data-icon="inline-start" />
                  Replay
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
        </Card>
      )}
    </Section>
  );

  const reportSection = (
    <Section
      key="report"
      id="report"
      title="Report · real users by segment"
      aside={metrics ? <Badge variant="secondary">{sourceLabel(run)}</Badge> : null}
    >
      {metrics ? (
        <div className="flex flex-col gap-8">
          <SegmentKpis metrics={metrics} />
          {metrics.trend && (
            <div className="flex flex-col gap-3">
              <h3 className="text-lg font-semibold">Weekly completion by segment</h3>
              <p className="-mt-2 text-sm text-muted-foreground">Real users only. Vertical lines are production releases; a ringed dot marks the release that broke a segment.</p>
              <Card>
                <CardContent className="flex flex-col gap-4">
                  <TrendChart points={metrics.trend.points} releases={metrics.trend.releases} window={config.window} />
                  <details className="group">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                      <Table2 className="size-4" aria-hidden />
                      Table view
                    </summary>
                    <div className="mt-3">
                      <TrendTable points={metrics.trend.points} />
                    </div>
                  </details>
                </CardContent>
              </Card>
            </div>
          )}
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Funnel by segment</h3>
            <p className="-mt-2 text-sm text-muted-foreground">Share of sessions that reached each step, out of N. Lock = required step; ✕ = sessions that left there.</p>
            <Card>
              <CardContent>
                <Funnels metrics={metrics} flow={flow} />
              </CardContent>
            </Card>
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Friction hotspots</h3>
            {findings ? (
              <Findings findings={findings} runId={config.runId} fixedIds={fixedIds} metrics={metrics} replayBase={run.replayBase} />
            ) : (
              <Skeleton className="h-28 w-full" />
            )}
          </div>
          {run.themes?.length ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-lg font-semibold">Where sessions ended without an order</h3>
              <p className="-mt-2 text-sm text-muted-foreground">Themes from the analyzer, linked to the findings that explain them.</p>
              <ThemeCards themes={run.themes} unit="session" />
            </div>
          ) : null}
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

  const sections = [retestSection, fixSection, reportSection];
  const navItems: [string, string][] = [
    ...(retestLive ? ([["retest", "Live re-test"]] as [string, string][]) : []),
    ...(showFix ? ([["fix", "Fix & before/after"]] as [string, string][]) : []),
    ["report", "Report"],
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
              <Link href="/" className="hover:text-foreground hover:underline">
                Runs
              </Link>
              <span aria-hidden>/</span>
              <RunId runId={config.runId} className="text-foreground" />
            </nav>
            <h1 className="text-2xl font-bold tracking-tight">{flow?.goal ?? config.flowId}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <Badge variant="outline">Analysis</Badge>
              <span>
                Window <span className="text-foreground">{windowLabel(config.window)}</span>
              </span>
              <span>
                Release{" "}
                <span className="text-foreground">{release?.name ?? (config.posthog.buildSha ? "" : "all in window")}</span>{" "}
                {config.posthog.buildSha && <code className="font-mono text-foreground">{shortSha(config.posthog.buildSha)}</code>}
              </span>
              <span>{sourceLabel(run)}</span>
              {sessions !== undefined && (
                <span className="tabular">
                  N=<span className="text-foreground">{compact(sessions)}</span> sessions · {compact(users ?? 0)} users
                </span>
              )}
              <TimeAgo iso={config.createdAt} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {latestFix?.retestRunId && (
              <Button variant="secondary" asChild>
                <Link href={`/runs/${latestFix.retestRunId}?replay=1`}>
                  <Play data-icon="inline-start" />
                  Replay re-test
                </Link>
              </Button>
            )}
            <PitchModeButton runId={config.runId} />
          </div>
        </div>

        <Card size="sm">
          <CardContent className="flex flex-col gap-3">
            <PhaseStepper phase={phase} kind="analysis" hasFix={!!fix} failedAt={failedAt} />
            {(status.message || live || error || latestFix) && (
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
                      {latestFix.prUrl && !!latestFix.prNumber && (
                        <Button variant="link" size="sm" asChild>
                          <a href={latestFix.prUrl} target="_blank" rel="noreferrer">
                            PR #{latestFix.prNumber}
                          </a>
                        </Button>
                      )}
                    </span>
                  )}
                  {error && <span className="text-destructive">Lost connection to the dashboard server, retrying…</span>}
                  {status.inferred && <span className="text-muted-foreground">(phase inferred from files)</span>}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {phase === "failed" && (
          <Alert variant="destructive">
            <CircleX />
            <AlertTitle>Run failed</AlertTitle>
            <AlertDescription>{status.error ?? status.message ?? "The orchestrator reported a failure."}</AlertDescription>
          </Alert>
        )}

        <nav className="flex gap-1 border-b pb-1 text-sm" aria-label="Sections">
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

/* -------------------------------------------------------------- retest */

function RetestView({ initial, replay }: { initial: RunDetail; replay: boolean }) {
  const { run, live, error } = usePolledRun(initial, !replay);
  const events = useMemo(() => initial.events ?? [], [initial.events]);
  const r = useReplay(events, replay);
  const { config, flow } = run;

  const view = useMemo(() => {
    if (!replay || r.atEnd) return { agents: run.agents, metrics: run.metrics ?? run.provisionalMetrics, giveUps: run.giveUps, provisional: !run.metrics };
    const partial = events.slice(0, r.shown);
    const finalShot = new Map(run.agents.map((a) => [a.agentId, a]));
    // One screenshot per agent exists (its last screen): show it once the agent is done.
    const agents = deriveAgents(config, partial, flow, true).map((a) =>
      a.state === "running" ? a : { ...a, latestScreenshot: finalShot.get(a.agentId)?.latestScreenshot, screenshotVersion: finalShot.get(a.agentId)?.screenshotVersion },
    );
    return { agents, metrics: deriveMetrics(config, partial, flow), giveUps: giveUpGroups(partial, flow), provisional: true };
  }, [replay, r.atEnd, r.shown, run, events, config, flow]);

  const n = view.agents.length;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
              <Link href="/" className="hover:text-foreground hover:underline">
                Runs
              </Link>
              <span aria-hidden>/</span>
              {config.baselineRunId && (
                <>
                  <RunId runId={config.baselineRunId} href={`/runs/${config.baselineRunId}`} />
                  <span aria-hidden>/</span>
                </>
              )}
              <RunId runId={config.runId} retest className="text-foreground" />
            </nav>
            <h1 className="text-2xl font-bold tracking-tight">Re-test swarm on the preview</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <span>
                Build <code className="font-mono text-foreground">{shortSha(config.posthog.buildSha)}</code>
              </span>
              <span className="truncate">
                Preview <code className="font-mono text-foreground">{config.targetUrl.replace(/^https?:\/\//, "")}</code>
              </span>
              <span className="tabular">
                N=<span className="text-foreground">{n}</span> agents
              </span>
              <span className="flex items-center gap-3">
                {config.personaIds.map((p) => (
                  <span key={p} className="flex items-center gap-1.5">
                    <PersonaAvatar personaId={p} size={26} label="" animate={false} />
                    {personaShort(p)} <span className="tabular text-foreground">×{config.seeds[p]?.length ?? 0}</span>
                  </span>
                ))}
              </span>
              <TimeAgo iso={config.createdAt} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {config.baselineRunId && <PitchModeButton runId={config.baselineRunId} />}
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

        {!replay && (
          <Card size="sm">
            <CardContent className="flex flex-wrap items-center gap-3 text-sm">
              {live ? (
                <span className="flex items-center gap-1.5 font-medium">
                  <Radio className="size-4 animate-pulse" style={{ color: "var(--status-running)" }} aria-hidden />
                  Live · reading the swarm&apos;s tracks from PostHog as they are ingested
                </span>
              ) : (
                <span>Analyzed from the run&apos;s PostHog snapshot (posthog.jsonl).</span>
              )}
              {error && <span className="text-destructive">Lost connection to the dashboard server, retrying…</span>}
            </CardContent>
          </Card>
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
              <AlertDescription>This re-test has no PostHog snapshot yet.</AlertDescription>
            </Alert>
          ))}
      </div>

      <Section id="agents" title="Agents">
        {view.agents.length ? (
          <SwarmTabs run={{ ...run, metrics: view.metrics, provisionalMetrics: undefined }} agents={view.agents} live={live || (replay && !r.atEnd)} derived={replay} />
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No agents yet</EmptyTitle>
              <EmptyDescription>Agents appear once the swarm starts on the preview.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </Section>

      <Section id="personas" title="Personas" aside={view.provisional ? <Badge variant="outline">Provisional · from the sessions so far</Badge> : <Badge variant="secondary">Analyzer metrics</Badge>}>
        {view.metrics?.personas.length ? (
          <div className="flex flex-col gap-6">
            <PersonaKpis metrics={view.metrics} />
            <Card>
              <CardContent>
                <Funnels metrics={view.metrics} flow={flow} />
              </CardContent>
            </Card>
          </div>
        ) : (
          <Skeleton className="h-40" />
        )}
      </Section>

      <Section id="give-ups" title="Why agents gave up">
        <GiveUps groups={view.giveUps} themes={replay && !r.atEnd ? undefined : run.themes} />
      </Section>
    </div>
  );
}

export function RunView({ initial, replay }: { initial: RunDetail; replay: boolean }) {
  return initial.config.kind === "retest" ? <RetestView initial={initial} replay={replay} /> : <AnalysisView initial={initial} />;
}
