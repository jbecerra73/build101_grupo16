"use client";

import Link from "next/link";
import { ArrowRight, CircleCheck, CircleSlash, CircleX, ExternalLink, Bot, Target, TriangleAlert } from "lucide-react";
import type { Finding, PersonaComparison } from "@frictionswarm/shared";
import { FixStatusBadge, PersonaDot } from "@/components/bits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { duration, personaShort, shortSha, signedPts } from "@/lib/format";
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
  const med = (c: PersonaComparison["before"], k: "medianSteps" | "medianTimeMs") =>
    c.completed === 0 ? "—" : k === "medianTimeMs" ? duration(c[k]) : String(c[k]);
  return (
    <Table className="text-base">
      <TableHeader>
        <TableRow>
          <TableHead>Persona</TableHead>
          <TableHead className="text-right">Before</TableHead>
          <TableHead className="text-right">After</TableHead>
          <TableHead>Completion Δ</TableHead>
          <TableHead>Median steps · valid</TableHead>
          <TableHead>Median time · valid</TableHead>
          <TableHead>Regressions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {comparisons.map((c) => (
          <TableRow key={c.personaId}>
            <TableCell>
              <span className="flex items-center gap-2 font-medium">
                <PersonaDot id={c.personaId} />
                {personaShort(c.personaId)}
                {targeted.includes(c.personaId) && (
                  <Badge variant="secondary">
                    <Target data-icon="inline-start" />
                    targeted
                  </Badge>
                )}
              </span>
            </TableCell>
            <TableCell className="text-right tabular">
              {c.before.completed}/{c.before.n}
            </TableCell>
            <TableCell className="text-right tabular font-medium">
              {c.after.completed}/{c.after.n}
            </TableCell>
            <TableCell>
              <Delta pts={c.completionDeltaPts} />
            </TableCell>
            <TableCell className="tabular text-muted-foreground">
              {med(c.before, "medianSteps")} <ArrowRight className="inline size-3.5" aria-label="to" /> {med(c.after, "medianSteps")}
            </TableCell>
            <TableCell className="tabular text-muted-foreground">
              {med(c.before, "medianTimeMs")} <ArrowRight className="inline size-3.5" aria-label="to" /> {med(c.after, "medianTimeMs")}
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

function AttemptCard({ a, findings, total }: { a: FixAttemptView; findings: Finding[]; total: number }) {
  const fixed = a.findingIds.map((id) => findings.find((f) => f.id === id) ?? ({ id, title: id } as Pick<Finding, "id" | "title">));
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
            <Link className="underline underline-offset-4" href={`/runs/${a.retestRunId}`}>
              Retest run {a.retestRunId}
            </Link>
          )}
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          {a.previewUrl && (
            <Button variant="outline" asChild>
              <a href={a.previewUrl} target="_blank" rel="noreferrer">
                Preview
                <ExternalLink data-icon="inline-end" />
              </a>
            </Button>
          )}
          {a.prUrl && (
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
                  Threshold: completion up ≥ 20 pts for a targeted persona and no metric worse for any persona, control included.
                  Retest uses fresh seeds. Directional signal at this N, not a significance test.
                </span>
              </AlertDescription>
            </Alert>
          </>
        ) : (
          <p className="text-muted-foreground">
            {a.status === "failed" ? "No retest was run." : "Before/after appears once the retest on the preview is compared."}
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
