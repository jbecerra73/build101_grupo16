import Link from "next/link";
import { FlaskConical, Play, ScanSearch } from "lucide-react";
import { flowOf } from "@frictionswarm/shared";
import { FixStatusBadge, PhaseBadge } from "@/components/bits";
import { PersonaAvatar } from "@/components/persona/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { compact, formatDateTime, pct1, personaShort, segmentColor, segmentShort, shortSha, windowLabel } from "@/lib/format";
import { listRuns, runsDir } from "@/lib/runs";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await listRuns();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Runs</h1>
          <p className="text-muted-foreground">
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
            <Table className="text-base">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Run</TableHead>
                  <TableHead>Flow</TableHead>
                  <TableHead>Completion by segment / persona</TableHead>
                  <TableHead className="text-right">N</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Fix</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.runId}>
                    <TableCell className="max-w-96 pl-4 whitespace-normal">
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Link href={`/runs/${r.runId}`} className="font-mono text-sm font-medium break-all hover:underline">
                            {r.runId}
                          </Link>
                          <Badge variant={r.config.kind === "retest" ? "secondary" : "outline"}>{r.config.kind}</Badge>
                        </div>
                        <span className="text-sm text-muted-foreground">{formatDateTime(r.config.createdAt)}</span>
                        {r.config.baselineRunId && (
                          <span className="text-sm break-all text-muted-foreground">retest of {r.config.baselineRunId}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-56 whitespace-normal">
                      <div className="flex flex-col">
                        <span className="line-clamp-2">{flowOf(r.config)?.goal ?? r.config.flowId}</span>
                        <span className="text-sm text-muted-foreground">
                          {r.config.kind === "retest" ? `preview ${shortSha(r.config.posthog.buildSha)}` : windowLabel(r.config.window)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
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
                      <PhaseBadge phase={r.status.phase} />
                    </TableCell>
                    <TableCell>{r.fixStatus ? <FixStatusBadge status={r.fixStatus} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="pr-4">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" asChild>
                          <Link href={`/runs/${r.runId}`}>Open</Link>
                        </Button>
                        {(r.config.kind === "retest" || r.retestRunId) && (
                          <Button variant="secondary" asChild>
                            <Link href={`/runs/${r.config.kind === "retest" ? r.runId : r.retestRunId}?replay=1`}>
                              <Play data-icon="inline-start" />
                              Replay
                            </Link>
                          </Button>
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
