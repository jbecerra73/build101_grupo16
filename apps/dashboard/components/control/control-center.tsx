"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  Ban,
  Bot,
  Cloud,
  Hourglass,
  Inbox,
  Laptop,
  PlugZap,
  ScanSearch,
  RotateCcw,
  Settings as SettingsIcon,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { SEGMENTS } from "@frictionswarm/shared";
import { FixStatusBadge, PhaseBadge } from "@/components/bits";
import { PersonaAvatar } from "@/components/persona/avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cancelRun, getControl, getRun, retryRun } from "@/lib/client/api";
import type { ControlOverview, OrchestratorHeartbeat, Settings } from "@/lib/control-types";
import { usePoll, useNow } from "@/lib/hooks/use-poll";
import { compact, duration, formatDateTime, pct1, personaShort, RETEST_PHASES, segmentColor, segmentShort, relativeTime, windowLabel } from "@/lib/format";
import type { RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { HeartbeatDot, MiniFunnel, MiniStepper, UsageMeter } from "./bits";

const STALE_MS = 20_000;

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : relativeTime(iso, now);
};

function PersonaStack({ ids, size = 30 }: { ids: string[]; size?: number }) {
  return (
    <span className="flex -space-x-2">
      {ids.map((p) => (
        <PersonaAvatar key={p} personaId={p} size={size} label={personaShort(p)} animate={false} className="rounded-full ring-2 ring-card" />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------ top tiles */

function OrchestratorCard({ hb, now }: { hb?: OrchestratorHeartbeat; now: number }) {
  const online = !!hb && now - Date.parse(hb.lastSeenAt) <= STALE_MS;
  const HostIcon = hb?.host === "tenki" ? Cloud : Laptop;
  return (
    <Card className={cn("relative overflow-hidden", !online && "bg-muted/40")}>
      <CardHeader>
        <CardDescription>Orchestrator</CardDescription>
        <CardTitle className="flex items-center gap-3 text-3xl">
          <HeartbeatDot online={online} size="lg" />
          {online ? "Online" : "Offline"}
        </CardTitle>
        <CardAction>{online ? <PlugZap className="size-6 text-muted-foreground" aria-hidden /> : <Unplug className="size-6 text-muted-foreground" aria-hidden />}</CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hb ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Host</dt>
              <dd className="flex items-center gap-1.5 font-medium">
                <HostIcon className="size-4" aria-hidden />
                {hb.host}
                {hb.sandboxId && <code className="truncate font-mono text-xs text-muted-foreground">{hb.sandboxId}</code>}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Last seen</dt>
              <dd className="tabular font-medium">{ago(hb.lastSeenAt, now)}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono text-xs font-medium">{hb.version}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Up since</dt>
              <dd className="tabular font-medium">{duration(now - Date.parse(hb.startedAt))}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">No heartbeat has ever been written. Start the orchestrator daemon to pick up queued runs.</p>
        )}
        {!online && hb && (
          <p className="text-sm text-muted-foreground">Queued runs wait until the orchestrator writes a heartbeat again (every ~5 s).</p>
        )}
      </CardContent>
    </Card>
  );
}

function ModeRow({ label, value, hint, costly }: { label: string; value: string; hint: string; costly: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="font-mono text-3xl font-bold tracking-tight uppercase">{value}</span>
        <span className="text-sm text-muted-foreground">{hint}</span>
      </div>
      {costly ? (
        <Badge variant="outline" className="mt-1 gap-1.5">
          <TriangleAlert data-icon="inline-start" style={{ color: "var(--status-warning)" }} />
          live
        </Badge>
      ) : (
        <Badge variant="secondary" className="mt-1">
          offline
        </Badge>
      )}
    </div>
  );
}

function ModeCard({ s }: { s: Settings }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>Backend mode</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/settings">
              <SettingsIcon data-icon="inline-start" />
              Change
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ModeRow
          label="Swarm runner"
          value={s.swarmRunner}
          hint={s.swarmRunner === "tenki" ? "Real browsers in tenki sandboxes · spends credits" : `Simulated agents on the preview at ${s.swarmSpeed}× (PostHog tracks from posthog-sim)`}
          costly={s.swarmRunner === "tenki"}
        />
        <ModeRow
          label="Fix loop"
          value={s.fixLoop}
          hint={s.fixLoop === "real" ? "Coding agent opens real PRs on the storefront" : "Rehearsal: same transitions, no PR opened"}
          costly={s.fixLoop === "real"}
        />
      </CardContent>
    </Card>
  );
}

function UsageCard({ usage }: { usage: ControlOverview["usage"] }) {
  const left = Math.max(0, usage.max - usage.runs);
  return (
    <Card>
      <CardHeader>
        <CardDescription>Runs today</CardDescription>
        <CardTitle className="flex items-baseline gap-2">
          <span className="text-5xl font-semibold tracking-tight">{usage.runs}</span>
          <span className="tabular text-xl font-normal text-muted-foreground">/ {usage.max}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <UsageMeter used={usage.runs} max={usage.max} />
        <p className="text-sm text-muted-foreground">
          {left === 0 ? (
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <Ban className="size-4" style={{ color: "var(--status-critical)" }} aria-hidden />
              Daily cap reached: new runs are refused until tomorrow
            </span>
          ) : (
            <>
              <span className="tabular font-medium text-foreground">{left}</span> left · resets at midnight UTC ({usage.date})
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------- active rows */

function CancelButton({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={busy}>
          {busy ? <Spinner data-icon="inline-start" /> : <Ban data-icon="inline-start" />}
          Cancel
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this pipeline?</AlertDialogTitle>
          <AlertDialogDescription>
            <code className="font-mono">{runId}</code> stops at the next checkpoint: running agents are closed and no further fix or PR step is started.
            The run folder is kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              setBusy(true);
              try {
                await cancelRun(runId, "Cancelled from the control center");
                toast.success(`Cancel requested for ${runId}`);
                onDone();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Cancel failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel pipeline
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ActiveRow({ r, now, onChange }: { r: RunSummary; now: number; onChange: () => void }) {
  const detail = usePoll(() => getRun(r.runId), 1500).data;
  const phase = detail?.status.phase ?? r.status.phase;
  const retestId = detail?.status.retestRunId ?? r.retestRunId;
  const retest = usePoll(() => getRun(retestId!), 1500, !!retestId && RETEST_PHASES.includes(phase)).data;
  const agents = retest?.agents ?? [];
  const running = agents.filter((a) => a.state === "running").length;
  const sessions = detail?.metrics?.segments.reduce((n, s) => n + s.n, 0);
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24 }}
      className="grid items-center gap-x-6 gap-y-3 border-t px-4 py-4 first:border-t-0 md:grid-cols-[minmax(14rem,1.2fr)_auto_auto_minmax(10rem,1fr)_auto]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <PersonaStack ids={SEGMENTS.map((s) => s.personaId)} size={36} />
        <div className="flex min-w-0 flex-col">
          <Link href={`/runs/${r.runId}`} className="truncate font-mono text-sm font-medium hover:underline">
            {r.runId}
          </Link>
          <span className="tabular text-sm text-muted-foreground">
            {windowLabel(r.config.window)} · started {ago(r.config.createdAt, now)}
          </span>
        </div>
      </div>
      <MiniStepper phase={phase} />
      <MiniFunnel metrics={detail?.metrics} />
      <div className="flex flex-col text-sm">
        {RETEST_PHASES.includes(phase) ? (
          <span className="tabular">
            <span className="text-lg font-semibold">{running}</span> <span className="text-muted-foreground">of {agents.length} re-test agents running</span>
          </span>
        ) : (
          <span className="tabular">
            <span className="text-lg font-semibold">{sessions !== undefined ? compact(sessions) : "…"}</span> <span className="text-muted-foreground">real-user sessions</span>
          </span>
        )}
        <span className="line-clamp-1 text-muted-foreground">{detail?.status.message ?? r.status.message ?? "—"}</span>
      </div>
      <div className="flex gap-2 md:justify-end">
        <Button variant="secondary" asChild>
          <Link href={`/runs/${r.runId}`}>Watch</Link>
        </Button>
        <CancelButton runId={r.runId} onDone={onChange} />
      </div>
    </motion.li>
  );
}

function IdleIllustration() {
  return (
    <div className="flex items-end gap-2" aria-hidden>
      <PersonaAvatar personaId="rosa" mood="idle" size={44} label="" animate={false} />
      <PersonaAvatar personaId="kai" mood="idle" size={52} label="" animate={false} />
      <PersonaAvatar personaId="typical" mood="idle" size={44} label="" animate={false} />
    </div>
  );
}

/* --------------------------------------------------------------- recent */

function RetryButton({ r }: { r: RunSummary }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await retryRun(r.runId);
          toast.success(`Retry queued as ${res.runId}`);
          router.push(`/runs/${res.runId}`);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Retry failed");
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}
      Retry
    </Button>
  );
}

export function ControlCenter() {
  const poll = usePoll(getControl, 2000);
  const now = useNow(1000);
  const c = poll.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Control center</h1>
          <p className="text-muted-foreground">Orchestrator health, the queue, pipelines in flight and today&apos;s budget.</p>
        </div>
        <div className="flex items-center gap-2">
          {poll.error ? (
            <Badge variant="outline" className="gap-1.5">
              <TriangleAlert data-icon="inline-start" style={{ color: "var(--status-warning)" }} />
              Can&apos;t reach the dashboard API, retrying
            </Badge>
          ) : null}
          <Button asChild>
            <Link href="/runs/new">
              <ScanSearch data-icon="inline-start" />
              Analyze
            </Link>
          </Button>
        </div>
      </div>

      {!c ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-48 lg:col-span-3" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <OrchestratorCard hb={c.orchestrator} now={now} />
            <ModeCard s={c.settings} />
            <UsageCard usage={c.usage} />
          </div>

          <Card className="gap-0 pb-0">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-xl">
                <Bot className="size-5" aria-hidden />
                Active pipelines
                <span className="tabular font-normal text-muted-foreground">{c.active.length}</span>
              </CardTitle>
              <CardDescription>Analyze → fix → preview → re-test → collect → compare, live.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {c.active.length ? (
                <ul>
                  <AnimatePresence initial={false}>
                    {c.active.map((r) => (
                      <ActiveRow key={r.runId} r={r} now={now} onChange={poll.refresh} />
                    ))}
                  </AnimatePresence>
                </ul>
              ) : (
                <Empty className="rounded-none border-t py-10">
                  <EmptyHeader>
                    <EmptyMedia>
                      <IdleIllustration />
                    </EmptyMedia>
                    <EmptyTitle>The swarm is resting</EmptyTitle>
                    <EmptyDescription>No pipeline is running. Analyze a flow and it shows up here with its phase and funnel, live.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button asChild>
                      <Link href="/runs/new">
                        <ScanSearch data-icon="inline-start" />
                        Analyze
                      </Link>
                    </Button>
                  </EmptyContent>
                </Empty>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Hourglass className="size-5" aria-hidden />
                  Queue
                  <span className="tabular font-normal text-muted-foreground">{c.queued.length}</span>
                </CardTitle>
                <CardDescription>Requests waiting for the orchestrator, oldest first.</CardDescription>
              </CardHeader>
              <CardContent>
                {c.queued.length ? (
                  <ol className="flex flex-col gap-2">
                    {c.queued.map((q, i) => (
                      <li key={q.requestId} className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2">
                        <span className="tabular flex size-7 items-center justify-center rounded-full bg-background text-sm font-semibold">{i + 1}</span>
                        <PersonaStack ids={SEGMENTS.map((s) => s.personaId)} size={26} />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate font-mono text-sm">{q.runId}</span>
                          <span className="tabular text-xs text-muted-foreground">
                            {windowLabel(q.req.window)} · {q.req.autoFix ? `auto-fix, ${SEGMENTS.length * (q.req.seedsPerPersona ?? c.settings.defaultSeedsPerPersona)} re-test agents` : "report only"} · {ago(q.requestedAt, now)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-muted-foreground">
                    <Inbox className="size-6 shrink-0" aria-hidden />
                    <span>Queue is empty. New runs are picked up within seconds.</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="gap-0 pb-0">
              <CardHeader className="pb-2">
                <CardTitle className="text-xl">Recent runs</CardTitle>
                <CardDescription>Finished pipelines. Retry re-runs the same analysis; any re-test gets fresh seeds.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {c.recent.length ? (
                  <Table className="text-base">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-6">Run</TableHead>
                        <TableHead>Completion by segment / persona</TableHead>
                        <TableHead>Outcome</TableHead>
                        <TableHead className="pr-6 text-right">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.recent.map((r) => (
                        <TableRow key={r.runId}>
                          <TableCell className="pl-6">
                            <div className="flex flex-col">
                              <Link href={`/runs/${r.runId}`} className="font-mono text-sm font-medium hover:underline">
                                {r.runId}
                              </Link>
                              <span className="text-xs text-muted-foreground">
                                {r.config.kind} · {formatDateTime(r.config.createdAt)}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {r.groups.map((g) => (
                                <span key={g.id} className="tabular inline-flex items-center gap-1.5 text-sm">
                                  {g.kind === "persona" ? (
                                    <PersonaAvatar personaId={g.personaId} size={22} label={personaShort(g.personaId)} animate={false} />
                                  ) : (
                                    <span aria-label={segmentShort(g.id)} className="inline-block size-2.5 rounded-full" style={{ backgroundColor: segmentColor(g.id) }} />
                                  )}
                                  {pct1(g.n ? g.completed / g.n : 0)} <span className="text-muted-foreground">of {compact(g.n)}</span>
                                </span>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1.5">
                              <PhaseBadge phase={r.status.phase} />
                              {r.fixStatus && <FixStatusBadge status={r.fixStatus} />}
                            </div>
                          </TableCell>
                          <TableCell className="pr-6 text-right">
                            {r.config.kind === "analysis" ? <RetryButton r={r} /> : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="px-6 pb-6 text-muted-foreground">No finished runs yet.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
