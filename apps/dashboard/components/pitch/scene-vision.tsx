"use client";

import { CircleCheck, CircleSlash, GitPullRequest, LoaderCircle } from "lucide-react";
import { PERSONAS } from "@frictionswarm/shared";
import { compact, personaShort, signedPts } from "@/lib/format";
import type { PitchData } from "./data";
import { Reveal } from "./parts";

type Check = { name: string; detail: string; state: "pass" | "fail" | "pending" };

export function SceneVision({ d }: { d: PitchData }) {
  const v = d.attempt?.verdict;
  const sessions = d.run.metrics?.segments.reduce((n, s) => n + s.n, 0) ?? 0;
  const targeted = v?.comparisons.filter((c) => v.targetedPersonas.includes(c.personaId)) ?? [];
  const control = v?.comparisons.find((c) => PERSONAS[c.personaId]?.control);
  const agents = d.retest?.agents.length ?? 0;
  const checks: Check[] = [
    { name: "Deploy preview", detail: "storefront built for this commit", state: d.attempt?.previewUrl ? "pass" : "pending" },
    { name: "FrictionSwarm / real-user evidence", detail: `${d.findings.length} findings from ${compact(sessions)} PostHog sessions`, state: d.findings.length ? "pass" : "pending" },
    {
      name: "FrictionSwarm / persona swarm",
      detail: v ? `${agents} agents · ${targeted.map((c) => `${personaShort(c.personaId)} ${signedPts(c.completionDeltaPts)}`).join(", ")}` : "swarm running on the preview",
      state: v ? (v.improved ? "pass" : "fail") : "pending",
    },
    {
      name: "FrictionSwarm / control holds",
      detail: control ? `${personaShort(control.personaId)}: ${control.regressions.length ? `${control.regressions.length} regression(s)` : "no regressions"}` : "waiting for the verdict",
      state: control ? (control.regressions.length ? "fail" : "pass") : "pending",
    },
  ];

  return (
    <div className="flex h-full items-center gap-24">
      <div className="flex flex-1 flex-col gap-8">
        <Reveal delay={0.05} y={8}>
          <span className="text-2xl font-medium tracking-wide text-muted-foreground uppercase">Vision</span>
        </Reveal>
        <Reveal delay={0.15}>
          <h1 className="text-[10rem] leading-[0.9] font-semibold tracking-tight">CI for UX.</h1>
        </Reveal>
        <Reveal delay={0.5}>
          <p className="max-w-[900px] text-5xl leading-tight text-muted-foreground">
            Every storefront PR, checked by <span className="text-foreground">real-user evidence</span> plus a <span className="text-foreground">persona swarm</span>.
          </p>
        </Reveal>
      </div>

      <Reveal delay={0.8} x={40} y={0} className="w-[720px] shrink-0">
        <div className="flex flex-col overflow-hidden rounded-3xl border bg-card">
          <div className="flex items-center gap-3 border-b px-7 py-5 text-2xl font-semibold">
            <GitPullRequest className="size-7" style={{ color: "var(--status-good)" }} aria-hidden />
            Checks on the storefront PR
          </div>
          <ul className="flex flex-col">
            {checks.map((c, i) => (
              <Reveal key={c.name} as="li" delay={1.1 + i * 0.3} x={16} y={0} className="flex items-start gap-4 border-b px-7 py-5 last:border-0">
                {c.state === "pass" ? (
                  <CircleCheck className="mt-0.5 size-8 shrink-0" style={{ color: "var(--status-good)" }} aria-label="passed" />
                ) : c.state === "fail" ? (
                  <CircleSlash className="mt-0.5 size-8 shrink-0" style={{ color: "var(--status-warning)" }} aria-label="not proven" />
                ) : (
                  <LoaderCircle className="mt-0.5 size-8 shrink-0 animate-spin text-muted-foreground" aria-label="pending" />
                )}
                <span className="flex flex-col">
                  <span className="text-2xl font-semibold">{c.name}</span>
                  <span className="tabular text-xl text-muted-foreground">{c.detail}</span>
                </span>
              </Reveal>
            ))}
          </ul>
        </div>
      </Reveal>
    </div>
  );
}
