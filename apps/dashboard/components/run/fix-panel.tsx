"use client";

import { ArrowLeftRight, ArrowRight, CircleCheck, CircleSlash, CircleX, ExternalLink, Bot, Info, Target, TriangleAlert } from "lucide-react";
import { PERSONAS, type Finding, type PersonaComparison } from "@frictionswarm/shared";
import { FixStatusBadge } from "@/components/bits";
import { PersonaAvatar } from "@/components/persona/avatar";
import { RunId } from "@/components/run-meta";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { compact, duration, pct, pct1, personaShort, segmentColor, segmentShort, shortSha, signedPts } from "@/lib/format";
import type { FixAttemptView, FixResultView } from "@/lib/types";

function Delta({ pts }: { pts: number }) {
  const tone = pts > 0 ? "var(--status-good)" : pts < 0 ? "var(--status-critical)" : "var(--muted-foreground)";
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold tabular">
      <span aria-hidden className="inline-block size-2 rounded-full" style={{ backgroundColor: tone }} />
      {signedPts(pts)}
    </span>
  );
}

function ComparisonTable({ comparisons, targeted }: { comparisons: PersonaComparison[]; targeted: string[] }) {
  const time = (c: { completed: number; medianTimeMs: number }) => (c.completed === 0 ? "—" : duration(c.medianTimeMs));
  return (
    <Table className="text-base">
      <TableHeader>
        <TableRow>
          <TableHead>Segment ↔ persona</TableHead>
          <TableHead className="text-right">Before · real users</TableHead>
          <TableHead className="text-right">After · persona swarm</TableHead>
          <TableHead>Completion Δ</TableHead>
          <TableHead>Median time · valid</TableHead>
          <TableHead>Regressions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {comparisons.map((c) => (
          <TableRow key={c.personaId}>
            <TableCell>
              <span className="flex items-center gap-2 font-medium">
                <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: segmentColor(c.segmentId) }} />
                {segmentShort(c.segmentId)}
                <ArrowLeftRight className="size-3.5 text-muted-foreground" aria-label="stood in by" />
                <PersonaAvatar personaId={c.personaId} size={30} label="" animate={false} mood={c.completionDeltaPts > 0 ? "success" : "idle"} />
                {personaShort(c.personaId)}
                {targeted.includes(c.personaId) ? (
                  <Badge variant="secondary">
                    <Target data-icon="inline-start" />
                    targeted
                  </Badge>
                ) : PERSONAS[c.personaId]?.control ? (
                  <Badge variant="outline">control</Badge>
                ) : null}
              </span>
            </TableCell>
            <TableCell className="text-right">
              <span className="flex flex-col items-end">
                <span className="tabular font-medium">{pct1(c.before.completionRate)}</span>
                <span className="tabular text-sm text-muted-foreground">
                  {compact(c.before.completed)}/{compact(c.before.n)} sessions
                </span>
              </span>
            </TableCell>
            <TableCell className="text-right">
              <span className="flex flex-col items-end">
                <span className="tabular font-semibold">{pct(c.after.completionRate)}</span>
                <span className="tabular text-sm text-muted-foreground">
                  {c.after.completed}/{c.after.n} agents
                </span>
              </span>
            </TableCell>
            <TableCell>
              <Delta pts={c.completionDeltaPts} />
            </TableCell>
            <TableCell className="tabular text-muted-foreground">
              {time(c.before)} <ArrowRight className="inline size-3.5" aria-label="to" /> {time(c.after)}
            </TableCell>
            <TableCell>
              {c.regressions.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span className="flex flex-col gap-0.5">
                  {c.regressions.map((r) => (
                    <span key={r} className="flex items-center gap-1.5 text-sm">
                      <TriangleAlert className="size-3.5 shrink-0" style={{ color: "var(--status-critical)" }} aria-hidden />
                      {r}
                    </span>
                  ))}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Before and after are different populations; the dashboard says so next to every verdict. */
export function PopulationsNote() {
  return (
    <Alert>
      <Info />
      <AlertTitle>Different populations: people vs. constrained agents</AlertTitle>
      <AlertDescription>
        Before is the segment&apos;s real users on production over the analysis window. After is the persona swarm on the deploy
        preview, with that segment&apos;s perception and action limits enforced. The comparison is a directional pre-merge check, not
        an A/B test: no significance is claimed, and N is shown on both sides.
      </AlertDescription>
    </Alert>
  );
}

function AttemptCard({ a, findings, total }: { a: FixAttemptView; findings: Finding[]; total: number }) {
  // Retries target the previous re-test's findings (a.targets), whose ids aren't the analysis's.
  const fixed = a.targets ?? a.findingIds.map((id) => findings.find((f) => f.id === id) ?? ({ id, title: id } as Pick<Finding, "id" | "title">));
  const v = a.verdict;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3 text-lg">
          Attempt {a.attempt}
          {total > 1 && <span className="text-sm font-normal text-muted-foreground">of {total}</span>}
          <FixStatusBadge status={a.status} />
        </CardTitle>
        <CardDescription className="flex flex-wrap gap-x-4 gap-y-1">
          {a.branch && (
            <span>
              Branch <code className="font-mono">{a.branch}</code>
            </span>
          )}
          {a.commitSha && (
            <span>
              Commit <code className="font-mono">{shortSha(a.commitSha)}</code>
            </span>
          )}
          {a.retestRunId && (
            <span className="inline-flex items-center gap-1.5">
              Re-test run <RunId runId={a.retestRunId} href={`/runs/${a.retestRunId}`} retest className="text-foreground" />
            </span>
          )}
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          {a.previewUrl && !!a.prNumber && (
            <Button variant="outline" asChild>
              <a href={a.previewUrl} target="_blank" rel="noreferrer">
                Preview
                <ExternalLink data-icon="inline-end" />
              </a>
            </Button>
          )}
          {/* The offline rehearsal fix loop (FIX_LOOP=fake) opens no PR: prNumber 0. */}
          {a.prUrl && !a.prNumber && <Badge variant="outline">Rehearsal · no PR opened</Badge>}
          {a.prUrl && !!a.prNumber && (
            <Button asChild>
              <a href={a.prUrl} target="_blank" rel="noreferrer">
                PR #{a.prNumber ?? ""}
                <ExternalLink data-icon="inline-end" />
              </a>
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-medium text-muted-foreground">Findings targeted</h4>
            <ul className="flex flex-col gap-1">
              {fixed.map((f) => (
                <li key={f.id} className="flex gap-2">
                  <Badge variant="outline" className="font-mono">
                    {f.id}
                  </Badge>
                  <span>{f.title}</span>
                </li>
              ))}
            </ul>
          </div>
          {a.summary && (
            <div className="flex flex-col gap-2">
              <h4 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <Bot className="size-4" aria-hidden />
                Coding agent&apos;s summary
              </h4>
              <p className="leading-relaxed">{a.summary}</p>
            </div>
          )}
        </div>

        {a.error && (
          <Alert variant="destructive">
            <CircleX />
            <AlertTitle>Fix failed</AlertTitle>
            <AlertDescription>{a.error}</AlertDescription>
          </Alert>
        )}

        {v ? (
          <>
            <ComparisonTable comparisons={v.comparisons} targeted={v.targetedPersonas} />
            <PopulationsNote />
            <Alert>
              {v.improved ? <CircleCheck style={{ color: "var(--status-good)" }} /> : <CircleSlash style={{ color: "var(--status-warning)" }} />}
              <AlertTitle className="text-base">
                {v.improved ? "Improvement proven against the threshold" : "Fix attempted, not proven"}
              </AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4 text-base text-foreground">
                  {v.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <span className="text-sm">
                  Threshold: a targeted persona completes ≥ 20 pts more than its segment, and no persona is below its segment on
                  completion or any step&apos;s conversion, control included. The re-test uses fresh seeds.
                </span>
              </AlertDescription>
            </Alert>
          </>
        ) : (
          <p className="text-muted-foreground">
            {a.status === "failed" ? "No re-test was run." : "Before/after appears once the swarm's PostHog tracks on the preview are compared."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function FixPanel({ fix, findings }: { fix: FixResultView; findings: Finding[] }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        Storefront repo <code className="font-mono">{fix.repo}</code> ·{" "}
        <span className="tabular">{fix.attempts.length}</span> attempt{fix.attempts.length === 1 ? "" : "s"}
      </p>
      {[...fix.attempts].reverse().map((a) => (
        <AttemptCard key={a.attempt} a={a} findings={findings} total={fix.attempts.length} />
      ))}
    </div>
  );
}
