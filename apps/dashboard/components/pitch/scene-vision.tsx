"use client";

import { CircleCheck, CircleSlash, GitPullRequest, LoaderCircle } from "lucide-react";
import { PERSONAS } from "@frictionswarm/shared";
import { compact, signedPts } from "@/lib/format";
import { personaEs } from "./es";
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
    { name: "Deploy preview", detail: "storefront construido para este commit", state: d.attempt?.previewUrl ? "pass" : "pending" },
    { name: "FrictionSwarm / evidencia de personas reales", detail: `${d.findings.length} findings de ${compact(sessions)} sesiones de PostHog`, state: d.findings.length ? "pass" : "pending" },
    {
      name: "FrictionSwarm / usuarios sintéticos",
      detail: v ? `${agents} agents · ${targeted.map((c) => `${personaEs(c.personaId)} ${signedPts(c.completionDeltaPts)}`).join(", ")}` : "swarm corriendo en el preview",
      state: v ? (v.improved ? "pass" : "fail") : "pending",
    },
    {
      name: "FrictionSwarm / control se mantiene",
      detail: control ? `${personaEs(control.personaId)}: ${control.regressions.length ? `${control.regressions.length} regresión(es)` : "sin regresiones"}` : "esperando el veredicto",
      state: control ? (control.regressions.length ? "fail" : "pass") : "pending",
    },
  ];

  return (
    <div className="flex h-full items-center gap-24">
      <div className="flex flex-1 flex-col gap-8">
        <Reveal delay={0.05} y={8}>
          <span className="text-2xl font-medium tracking-wide text-muted-foreground uppercase">Visión</span>
        </Reveal>
        <Reveal delay={0.15}>
          <h1 className="text-[8.5rem] leading-[0.9] font-semibold tracking-tight whitespace-nowrap">CI para UX.</h1>
        </Reveal>
        <Reveal delay={0.5}>
          <p className="max-w-[900px] text-5xl leading-tight text-muted-foreground">
            Cada actualización del ecommerce, verificada con <span className="text-foreground">evidencia de personas reales</span> más <span className="text-foreground">usuarios sintéticos</span>.
          </p>
        </Reveal>
      </div>

      <Reveal delay={0.8} x={40} y={0} className="w-[720px] shrink-0">
        <div className="flex flex-col overflow-hidden rounded-3xl border bg-card">
          <div className="flex items-center gap-3 border-b px-7 py-5 text-2xl font-semibold">
            <GitPullRequest className="size-7" style={{ color: "var(--status-good)" }} aria-hidden />
            Checks en el PR del storefront
          </div>
          <ul className="flex flex-col">
            {checks.map((c, i) => (
              <Reveal key={c.name} as="li" delay={1.1 + i * 0.3} x={16} y={0} className="flex items-start gap-4 border-b px-7 py-5 last:border-0">
                {c.state === "pass" ? (
                  <CircleCheck className="mt-0.5 size-8 shrink-0" style={{ color: "var(--status-good)" }} aria-label="aprobado" />
                ) : c.state === "fail" ? (
                  <CircleSlash className="mt-0.5 size-8 shrink-0" style={{ color: "var(--status-warning)" }} aria-label="no probado" />
                ) : (
                  <LoaderCircle className="mt-0.5 size-8 shrink-0 animate-spin text-muted-foreground" aria-label="pendiente" />
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
