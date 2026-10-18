import Link from "next/link";
import { FlaskConical, Play, ScanSearch } from "lucide-react";
import { runFlow } from "@frictionswarm/shared";
import { FixStatusBadge, PhaseBadge } from "@/components/bits";
import { RunId, TimeAgo } from "@/components/run-meta";
import { PersonaAvatar } from "@/components/persona/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { compact, pct1, personaShort, segmentColor, segmentShort, shortSha, windowLabel } from "@/lib/format";
import { listRuns, runsDir } from "@/lib/runs";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await listRuns();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">Runs</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Every analysis and re-test, newest first. Open one to read the report or watch it live; replay a re-test offline from its PostHog snapshot.
          </p>
        </div>
      </div>

      {runs.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FlaskConical />
            </EmptyMedia>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>
              Nothing found in <code className="font-mono">{runsDir()}</code>. Analyze a flow to see it here.
            </EmptyDescription>
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
      ) : (
        <Card className="py-0">
          <CardHeader className="sr-only">
            <CardTitle>Run history</CardTitle>
            <CardDescription>All runs found in the runs folder</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Run</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Flow</TableHead>
                  <TableHead>Completion by segment / persona</TableHead>
                  <TableHead className="text-right">N</TableHead>
                  <TableHead>Phase · Fix</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.runId}>
                    <TableCell className="pl-4">
                      <div className="flex flex-col gap-1">
                        <RunId runId={r.runId} href={`/runs/${r.runId}`} retest={r.config.kind === "retest"} />
                        {r.config.baselineRunId && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            of <RunId runId={r.config.baselineRunId} href={`/runs/${r.config.baselineRunId}`} />
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <TimeAgo iso={r.config.createdAt} stacked />
                    </TableCell>
                    <TableCell className="max-w-80 min-w-56 whitespace-normal">
                      <div className="flex flex-col">
                        <Link href={`/runs/${r.runId}`} className="line-clamp-2 font-medium hover:underline hover:decoration-primary hover:underline-offset-4">
                          {runFlow(r.config)?.goal ?? r.config.flowId}
                        </Link>
                        <span className="text-sm text-muted-foreground">
                          {r.config.kind === "retest" ? `preview ${shortSha(r.config.posthog.buildSha)}` : windowLabel(r.config.window)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-64 whitespace-normal">
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {r.groups.map((g) => (
                          <span key={g.id} className="inline-flex items-center gap-1.5">
                            {g.kind === "persona" ? (
                              <PersonaAvatar personaId={g.personaId} size={24} label="" animate={false} />
                            ) : (
                              <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: segmentColor(g.id) }} />
                            )}
                            <span>{g.kind === "persona" ? personaShort(g.id) : segmentShort(g.id)}</span>
                            <span className="tabular font-medium">{pct1(g.n ? g.completed / g.n : 0)}</span>
                          </span>
                        ))}
                        {r.groups[0]?.provisional && <span className="text-sm text-muted-foreground">so far</span>}
                        {!r.groups.length && <span className="text-sm text-muted-foreground">—</span>}
                      </div>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {compact(r.sessions)} <span className="text-muted-foreground">{r.config.kind === "retest" ? "agents" : "sessions"}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <PhaseBadge phase={r.status.phase} />
                        {r.fixStatus ? <FixStatusBadge status={r.fixStatus} /> : <span className="px-1 text-xs text-muted-foreground">No fix</span>}
                      </div>
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex justify-end gap-2">
                        {(r.config.kind === "retest" || r.retestRunId) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="secondary" size="icon-sm" asChild>
                                <Link href={`/runs/${r.config.kind === "retest" ? r.runId : r.retestRunId}?replay=1`} aria-label="Replay re-test">
                                  <Play />
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Replay re-test</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
