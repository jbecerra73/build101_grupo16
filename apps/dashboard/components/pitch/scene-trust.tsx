"use client";

import { CircleCheck, CircleX, Database, Dices, ShieldCheck, TriangleAlert } from "lucide-react";
import { PERSONAS } from "@frictionswarm/shared";
import { PersonaAvatar } from "@/components/persona/avatar";
import { fileUrl } from "@/components/run/screenshot";
import { pct1 } from "@/lib/format";
import { personaEs, segmentEs } from "./es";
import type { AgentState } from "@/lib/types";
import { pickCapture, trapChecks, type PitchData } from "./data";
import { FitBox, Reveal, SceneHeader } from "./parts";

const rosa = PERSONAS.rosa;
const kai = PERSONAS.kai;

/** Rosa's perception filter (shared/personas.ts), applied in CSS to a real desktop capture:
 * the worker downscales the screenshot to `downscale` and blurs it by `blur` px at that size.
 * Shown at `shownW` px for a `viewportW` px page, the blur is blur × shownW / (viewportW × downscale). */
function rosaBlurPx(shownW: number) {
  const p = rosa.perception;
  return ((p.blur ?? 0) * shownW) / (rosa.viewport.width * (p.downscale ?? 1));
}

const ZOOM_W = 820; // capture shown at 0.64× of the 1280px viewport, cropped to the top-left of the page

function RosaPanel({ runId, shot }: { runId: string; shot?: AgentState }) {
  const src = shot?.latestScreenshot ? fileUrl(runId, shot.latestScreenshot, shot.screenshotVersion) : undefined;
  const p = rosa.perception;
  const img = (filtered: boolean) =>
    src ? (
      // eslint-disable-next-line @next/next/no-img-element -- run screenshots come from the run store API
      <img
        src={src}
        alt={filtered ? "La misma página del storefront con el filtro de percepción de Rosa" : "Página del storefront, tal como se capturó"}
        className="absolute top-0 left-0 max-w-none"
        style={{ width: ZOOM_W, filter: filtered ? `blur(${rosaBlurPx(ZOOM_W).toFixed(2)}px)` : undefined }}
      />
    ) : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <PersonaAvatar personaId="rosa" size={52} label="" />
        <span className="text-3xl font-semibold">{personaEs("rosa")} ve menos</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[false, true].map((filtered) => (
          <Reveal key={String(filtered)} delay={filtered ? 0.9 : 0.4} className="flex flex-col gap-2">
            <div className="relative h-[290px] overflow-hidden rounded-xl border bg-white">
              {img(filtered)}
              {!src && <span className="absolute inset-0 flex items-center justify-center text-xl text-neutral-500">No hay captura en este run</span>}
            </div>
            <span className="text-xl">
              {filtered ? (
                <span className="font-semibold">Lo que recibe el agent de Rosa</span>
              ) : (
                <span className="text-muted-foreground">La página, capturada</span>
              )}
            </span>
          </Reveal>
        ))}
      </div>
      <p className="text-xl text-muted-foreground">
        {Math.round((p.downscale ?? 1) * 100)}% de tamaño · {p.blur}px de blur · el texto de menos de {p.minFontPx}px desaparece
      </p>
    </div>
  );
}

const KAI_W = 260; // capture shown at 260px for a 375px-wide phone
const KAI_H = 420;

function KaiPanel({ runId, shot }: { runId: string; shot?: AgentState }) {
  const src = shot?.latestScreenshot ? fileUrl(runId, shot.latestScreenshot, shot.screenshotVersion) : undefined;
  const cell = ((kai.actions.minTapTargetPx ?? 44) * KAI_W) / kai.viewport.width;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <PersonaAvatar personaId="kai" size={52} label="" />
        <span className="text-3xl font-semibold">El pulgar de {personaEs("kai")}</span>
      </div>
      <div className="flex gap-5">
        <Reveal delay={0.6} className="relative shrink-0 overflow-hidden rounded-2xl border-4 border-foreground/80 bg-white" >
          <div className="relative" style={{ width: KAI_W, height: KAI_H }}>
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element -- run screenshots come from the run store API
              <img src={src} alt="Captura del storefront en mobile" className="absolute top-0 left-0 max-w-none" style={{ width: KAI_W }} />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center text-lg text-neutral-500">Sin captura</span>
            )}
            {/* 44×44 CSS px tap-target grid */}
            <Reveal delay={1.2} y={0} className="absolute inset-0">
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  backgroundImage: `linear-gradient(to right, rgba(235,104,52,.55) 1.5px, transparent 1.5px), linear-gradient(to bottom, rgba(235,104,52,.55) 1.5px, transparent 1.5px)`,
                  backgroundSize: `${cell}px ${cell}px`,
                }}
              />
              {/* a 44px fingertip over the cart button, for scale */}
              <span
                className="absolute rounded-full border-[3px] border-[var(--persona-kai)] bg-[var(--persona-kai)]/25"
                style={{ width: cell, height: cell, left: (511 / 640) * KAI_W - cell / 2, top: (122 / 640) * KAI_W - cell / 2 }}
                aria-hidden
              />
            </Reveal>
          </div>
        </Reveal>
        <p className="flex flex-col justify-center text-xl">
          <span className="text-3xl font-semibold">{kai.actions.minTapTargetPx}px</span>
          <span className="text-muted-foreground">Un cuadro = un tap. Más chico es un miss.</span>
        </p>
      </div>
    </div>
  );
}

export function SceneTrust({ d, index }: { d: PitchData; index: number }) {
  const agents = d.retest?.agents ?? [];
  const runId = d.retest?.runId ?? "";
  const desktop = pickCapture(agents, "typical");
  const mobile = pickCapture(agents, "kai");
  const control = d.attempt?.verdict?.comparisons.find((c) => PERSONAS[c.personaId]?.control);
  const controlHolds = control ? control.regressions.length === 0 : undefined;
  const traps = trapChecks(d.findings);
  const found = traps.filter((t) => t.releaseRight).length;

  return (
    <div className="flex h-full flex-col gap-5">
      <SceneHeader index={index} kicker="Por qué confiar" title="Las restricciones se aplican, no se piden en el prompt" />

      <FitBox className="flex-1" innerClassName="gap-5">
      <div className="grid grid-cols-[1.2fr_1fr_0.9fr] gap-10">
        <RosaPanel runId={runId} shot={desktop} />
        <KaiPanel runId={runId} shot={mobile} />
        <ul className="flex flex-col gap-5 text-xl">
          <Reveal as="li" delay={1.4} x={20} y={0} className="flex gap-4">
            {controlHolds === false ? (
              <TriangleAlert className="mt-1 size-8 shrink-0" style={{ color: "var(--status-critical)" }} aria-hidden />
            ) : (
              <ShieldCheck className="mt-1 size-8 shrink-0" style={{ color: "var(--status-good)" }} aria-hidden />
            )}
            <span className="flex flex-col">
              <span className="text-2xl font-semibold">{controlHolds === false ? "La persona de control empeoró" : "La persona de control se mantiene"}</span>
              <span className="text-muted-foreground">
                {control ? `${personaEs(control.personaId)} ${pct1(control.after.completionRate)} vs ${segmentEs(control.segmentId)} ${pct1(control.before.completionRate)}` : "un fix no debe perjudicar al resto"}
              </span>
            </span>
          </Reveal>
          <Reveal as="li" delay={1.6} x={20} y={0} className="flex gap-4">
            <Dices className="mt-1 size-8 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex flex-col">
              <span className="text-2xl font-semibold">Seeds nuevos en cada re-test</span>
              <span className="text-muted-foreground">sin overfitting a un solo run</span>
            </span>
          </Reveal>
          <Reveal as="li" delay={1.8} x={20} y={0} className="flex gap-4">
            <Database className="mt-1 size-8 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex flex-col">
              <span className="text-2xl font-semibold">Primero, evidencia de usuarios reales</span>
              <span className="text-muted-foreground">Los findings vienen de PostHog, no de los agents</span>
            </span>
          </Reveal>
        </ul>
      </div>

      <Reveal delay={2.1} className="mt-auto flex flex-col gap-3 rounded-2xl border px-6 py-4">
        <span className="flex items-baseline gap-4">
          <span className="tabular text-[2.6rem] leading-none font-semibold">
            {found}/{traps.length}
          </span>
          <span className="text-2xl">trampas plantadas encontradas, cada una con el release que la introdujo</span>
        </span>
        <ol className="grid grid-cols-5 gap-5 text-lg">
          {traps.map((t) => (
            <li key={t.id} className="flex gap-2.5">
              {t.releaseRight ? (
                <CircleCheck className="mt-0.5 size-6 shrink-0" style={{ color: "var(--status-good)" }} aria-label="encontrada, release correcto" />
              ) : (
                <CircleX className="mt-0.5 size-6 shrink-0" style={{ color: "var(--status-critical)" }} aria-label={t.finding ? "encontrada, release incorrecto" : "no encontrada"} />
              )}
              <span className="leading-snug font-semibold">{t.label}</span>
            </li>
          ))}
        </ol>
      </Reveal>
      </FitBox>
    </div>
  );
}
