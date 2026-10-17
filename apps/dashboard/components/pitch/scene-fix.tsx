"use client";

import { Bot, FileCode2, FolderGit2, GitBranch, GitCommitVertical, GitPullRequest, Globe, ScanSearch, Users } from "lucide-react";
import { shortSha } from "@/lib/format";
import { cleanSummary, isRehearsal, type PitchData } from "./data";
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
  const fix = d.run.fix;
  if (!a)
    return (
      <div className="flex h-full flex-col gap-10">
        <SceneHeader index={index} kicker="The fix" title="The coding agent is preparing a fix" />
        <p className="text-4xl text-muted-foreground">{d.run.status.message ?? "No fix attempt on this run yet."}</p>
      </div>
    );
  const rehearsal = isRehearsal(a);
  const targets = a.findingIds.map((id) => d.findings.find((f) => f.id === id)).filter((f) => !!f);
  const files = (a as { files?: string[] }).files;
  const repo = fix?.repo.replace(/\s*\(rehearsal\)\s*$/i, "");

  return (
    <div className="flex h-full flex-col gap-8">
      <SceneHeader
        index={index}
        kicker="The fix"
        title="A coding agent opens the PR"
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
          <Panel className="flex h-full flex-col gap-6 bg-card p-8">
            <div className="flex items-center gap-4">
              <span className="flex size-16 items-center justify-center rounded-2xl bg-[var(--status-good)]/15">
                <GitPullRequest className="size-9" style={{ color: "var(--status-good)" }} aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-4xl font-semibold whitespace-nowrap">
                  {a.prNumber ? `PR #${a.prNumber}` : "Draft PR"}
                  <span className="text-2xl font-normal text-muted-foreground"> · attempt {a.attempt}</span>
                </span>
              </div>
              {rehearsal && (
                <span className="ml-auto shrink-0 rounded-full border-2 border-dashed border-[var(--status-warning)] px-4 py-1 text-lg font-semibold tracking-wide whitespace-nowrap uppercase">
                  Rehearsal · no PR opened
                </span>
              )}
            </div>

            <div className="flex flex-col gap-2 text-xl">
              {repo && (
                <span className="flex items-center gap-3 text-muted-foreground">
                  <FolderGit2 className="size-6" aria-hidden />
                  <code className="font-mono text-foreground">{repo}</code>
                </span>
              )}
              {a.branch && (
                <span className="flex items-center gap-3">
                  <GitBranch className="size-6 text-muted-foreground" aria-hidden />
                  <code className="font-mono">{a.branch}</code>
                </span>
              )}
              {a.commitSha && (
                <span className="flex items-center gap-3 text-muted-foreground">
                  <GitCommitVertical className="size-6" aria-hidden />
                  commit <code className="font-mono text-foreground">{shortSha(a.commitSha)}</code>
                </span>
              )}
              {a.previewUrl && (
                <span className="flex items-center gap-3 text-muted-foreground">
                  <Globe className="size-6" aria-hidden />
                  <code className="truncate font-mono text-lg text-foreground">{a.previewUrl.replace(/^https?:\/\//, "")}</code>
                </span>
              )}
            </div>

            {a.summary && (
              <Reveal delay={0.8} className="flex flex-col gap-2 rounded-2xl bg-muted/60 p-5">
                <span className="flex items-center gap-2 text-xl text-muted-foreground">
                  <Bot className="size-6" aria-hidden />
                  The coding agent&apos;s summary
                </span>
                <p className="text-xl leading-snug text-pretty">{cleanSummary(a.summary)}</p>
              </Reveal>
            )}

            {files?.length ? (
              <div className="flex flex-wrap gap-2 text-lg">
                {files.map((f) => (
                  <span key={f} className="flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono">
                    <FileCode2 className="size-4" aria-hidden />
                    {f}
                  </span>
                ))}
              </div>
            ) : null}

          </Panel>
        </Reveal>

        <div className="flex min-h-0 flex-col gap-4">
          <Reveal delay={0.5} y={0}>
            <span className="text-xl tracking-wide text-muted-foreground uppercase">Findings it targets</span>
          </Reveal>
          {targets.map((f, i) => (
            <Reveal key={f.id} delay={0.6 + i * 0.2} x={24} y={0}>
              <PitchFindingCard f={f} compactTitle />
            </Reveal>
          ))}
        </div>
      </div>
      </FitBox>
    </div>
  );
}
