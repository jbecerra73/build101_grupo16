"use client";

import { Bot, GitBranch, GitCommitVertical, GitPullRequest, Globe, ScanSearch, Users } from "lucide-react";
import { shortSha } from "@/lib/format";
import { isRehearsal, type PitchData } from "./data";
import { PitchFindingCard } from "./finding-card";
import { FitBox, Panel, Reveal, SceneHeader } from "./parts";

const PIPE = [
  { icon: ScanSearch, label: "Findings" },
  { icon: Bot, label: "Coding agent" },
  { icon: GitPullRequest, label: "Draft PR" },
  { icon: Globe, label: "Deploy preview" },
  { icon: Users, label: "Swarm re-test" },
];

export function SceneFix({ d, index }: { d: PitchData; index: number }) {
  const a = d.attempt;
  if (!a)
    return (
      <div className="flex h-full flex-col gap-10">
        <SceneHeader index={index} kicker="El fix" title="El coding agent está preparando un fix" />
        <p className="text-4xl text-muted-foreground">{d.run.status.message ?? "Todavía no hay un intento de fix en este run."}</p>
      </div>
    );
  const rehearsal = isRehearsal(a);
  const targets = a.findingIds.map((id) => d.findings.find((f) => f.id === id)).filter((f) => !!f);

  return (
    <div className="flex h-full flex-col gap-8">
      <SceneHeader
        index={index}
        kicker="El fix"
        title="Un coding agent abre el PR"
      />

      <ol className="-mt-2 flex items-center gap-2 text-xl whitespace-nowrap" aria-label="Pipeline">
        {PIPE.map((p, i) => (
          <Reveal key={p.label} as="li" delay={0.2 + i * 0.2} x={-12} y={0} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className="h-0.5 w-8 bg-border" />}
            <span className={i === PIPE.length - 1 ? "flex items-center gap-2 rounded-full border border-dashed px-4 py-1.5 text-muted-foreground" : "flex items-center gap-2 rounded-full border bg-card px-4 py-1.5"}>
              <p.icon className="size-5 text-muted-foreground" aria-hidden />
              {p.label}
            </span>
          </Reveal>
        ))}
      </ol>

      <FitBox className="flex-1" innerClassName="">
      <div className="grid min-h-0 flex-1 grid-cols-[1.08fr_1fr] gap-10">
        <Reveal delay={0.3} className="min-h-0">
          <Panel className="flex flex-col gap-8 bg-card p-8">
            <div className="flex items-center gap-4">
              <span className="flex size-16 items-center justify-center rounded-2xl bg-[var(--status-good)]/15">
                <GitPullRequest className="size-9" style={{ color: "var(--status-good)" }} aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-4xl font-semibold whitespace-nowrap">
                  {a.prNumber ? `PR #${a.prNumber}` : "Draft PR"}
                  <span className="text-2xl font-normal text-muted-foreground"> · intento {a.attempt}</span>
                </span>
              </div>
              {rehearsal && (
                <span className="ml-auto shrink-0 rounded-full border-2 border-dashed border-[var(--status-warning)] px-4 py-1 text-lg font-semibold tracking-wide whitespace-nowrap uppercase">
                  Rehearsal · sin PR abierto
                </span>
              )}
            </div>

            <div className="flex flex-col gap-3 text-2xl">
              {a.branch && (
                <span className="flex items-center gap-3">
                  <GitBranch className="size-7 text-muted-foreground" aria-hidden />
                  <code className="truncate font-mono">{a.branch}</code>
                </span>
              )}
              {a.commitSha && (
                <span className="flex items-center gap-3 text-muted-foreground">
                  <GitCommitVertical className="size-7" aria-hidden />
                  commit <code className="font-mono text-foreground">{shortSha(a.commitSha)}</code>
                </span>
              )}
            </div>
          </Panel>
        </Reveal>

        <div className="flex min-h-0 flex-col gap-4">
          <Reveal delay={0.5} y={0}>
            <span className="text-xl tracking-wide text-muted-foreground uppercase">Findings que ataca</span>
          </Reveal>
          {targets.map((f, i) => (
            <Reveal key={f.id} delay={0.6 + i * 0.2} x={24} y={0}>
              <PitchFindingCard f={f} minimal />
            </Reveal>
          ))}
        </div>
      </div>
      </FitBox>
    </div>
  );
}
