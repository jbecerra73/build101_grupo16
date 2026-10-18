"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowLeftRight, CircleCheck, CircleSlash, Info, Target, TriangleAlert } from "lucide-react";
import { PERSONAS, type PersonaComparison } from "@frictionswarm/shared";
import { PersonaAvatar } from "@/components/persona/avatar";
import { compact, pct1, personaColor } from "@/lib/format";
import { personaEs, segmentEs } from "./es";
import { cn } from "@/lib/utils";
import { isRehearsal, type PitchData } from "./data";
import { FitBox, Reveal, SceneHeader, useCountUp } from "./parts";

const ROW_AT = 0.4;
const ROW_STEP = 0.35;

function Bar({ rate, color, delay, muted }: { rate: number; color: string; delay: number; muted?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <div className="h-7 overflow-hidden rounded-md bg-muted" aria-hidden>
      <motion.div
        className="h-full origin-left rounded-md"
        style={{ backgroundColor: color, opacity: muted ? 0.55 : 1 }}
        initial={reduced ? false : { scaleX: 0 }}
        animate={{ scaleX: Math.max(rate, 0.004) }}
        transition={{ duration: 1.1, delay, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

function DeltaCount({ pts, delay }: { pts: number; delay: number }) {
  const v = useCountUp(Math.abs(pts), { delay, duration: 1.3 });
  const tone = pts > 0 ? "var(--status-good)" : pts < 0 ? "var(--status-critical)" : "var(--muted-foreground)";
  return (
    <span className="tabular flex items-baseline justify-end gap-2 text-6xl font-semibold tracking-tight">
      <span aria-hidden className="mb-2 inline-block size-4 self-center rounded-full" style={{ backgroundColor: tone }} />
      {pts > 0 ? "+" : pts < 0 ? "−" : "±"}
      {Math.round(v)}
      <span className="text-3xl font-medium text-muted-foreground">pts</span>
    </span>
  );
}

function Row({ c, i, targeted, dense }: { c: PersonaComparison; i: number; targeted: boolean; dense: boolean }) {
  const delay = ROW_AT + i * ROW_STEP;
  const control = PERSONAS[c.personaId]?.control;
  const color = personaColor(c.personaId);
  return (
    <Reveal delay={delay} as="li" className={cn("grid grid-cols-[560px_1fr_230px] items-center gap-10 border-b last:border-0", dense ? "py-4" : "py-7")}>
      <div className="flex items-center gap-4">
        <PersonaAvatar personaId={c.personaId} size={72} mood={c.completionDeltaPts > 0 && !c.regressions.length ? "success" : c.regressions.length ? "gave-up" : "idle"} label="" />
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2.5 text-3xl font-semibold whitespace-nowrap">
            {segmentEs(c.segmentId)}
            <ArrowLeftRight className="size-6 text-muted-foreground" aria-label="representado por" />
            {personaEs(c.personaId)}
          </span>
          <span className="flex items-center gap-2 text-xl text-muted-foreground">
            {targeted ? (
              <>
                <Target className="size-5" aria-hidden /> atacado por el fix
              </>
            ) : control ? (
              "control: no debe empeorar"
            ) : (
              "no atacado"
            )}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-[auto_1fr_290px] items-center gap-x-5 gap-y-3 text-xl whitespace-nowrap">
        <span className="text-muted-foreground">Usuarios reales</span>
        <Bar rate={c.before.completionRate} color="var(--muted-foreground)" delay={delay + 0.15} muted />
        <span className="tabular">
          <span className="text-2xl font-semibold">{pct1(c.before.completionRate)}</span>{" "}
          <span className="text-muted-foreground">
            {compact(c.before.completed)}/{compact(c.before.n)} sesiones
          </span>
        </span>
        <span className="text-muted-foreground">Persona swarm</span>
        <Bar rate={c.after.completionRate} color={color} delay={delay + 0.3} />
        <span className="tabular">
          <span className="text-2xl font-semibold">{pct1(c.after.completionRate)}</span>{" "}
          <span className="text-muted-foreground">
            {c.after.completed}/{c.after.n} agents
          </span>
        </span>
        {c.regressions.length > 0 && (
          <p className="col-span-3 flex items-start gap-2 text-lg leading-snug whitespace-normal">
            <TriangleAlert className="mt-0.5 size-5 shrink-0" style={{ color: "var(--status-critical)" }} aria-hidden />
            <span>
              <span className="font-semibold">{c.regressions.length > 1 ? "Regresiones" : "Regresión"}:</span> {c.regressions.join(" · ")}
            </span>
          </p>
        )}
      </div>

      <DeltaCount pts={c.completionDeltaPts} delay={delay + 0.3} />
    </Reveal>
  );
}

function Stamp({ improved, rehearsal, delay }: { improved: boolean; rehearsal: boolean; delay: number }) {
  const reduced = useReducedMotion();
  const tone = improved ? "var(--status-good)" : "var(--status-warning)";
  const Icon = improved ? CircleCheck : CircleSlash;
  return (
    <motion.div
      role="status"
      className="flex shrink-0 flex-col items-center gap-1 rounded-2xl border-4 bg-background px-8 py-4"
      style={{ borderColor: tone, rotate: -4 }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduced ? { duration: 0.2 } : { type: "spring", stiffness: 380, damping: 18, delay }}
    >
      <span className="flex items-center gap-3 text-[2.6rem] font-bold tracking-tight whitespace-nowrap uppercase">
        <Icon className="size-10" style={{ color: tone }} aria-hidden />
        {improved ? "Flujo aprobado por los agentes" : "No probado"}
      </span>
      <span className="text-lg text-muted-foreground">
        {improved ? "mejora probada contra el umbral" : "PR cerrado con las métricas, label not-proven"}
        {rehearsal ? " · rehearsal" : ""}
      </span>
    </motion.div>
  );
}

export function SceneBeforeAfter({ d, index }: { d: PitchData; index: number }) {
  const a = d.attempt;
  const v = a?.verdict;
  if (!v)
    return (
      <div className="flex h-full flex-col gap-10">
        <SceneHeader index={index} kicker="Antes / después" title="Esperando el veredicto" />
        <p className="text-4xl text-muted-foreground">{d.run.status.message ?? "El antes/después aparece cuando se comparan los tracks del swarm."}</p>
      </div>
    );
  const stampAt = ROW_AT + v.comparisons.length * ROW_STEP + 1.4;
  return (
    <div className="flex h-full flex-col gap-6">
      <SceneHeader index={index} kicker="Antes / después · por segmento" title="Usuarios reales antes, persona swarm después" />
      <FitBox className="flex-1" innerClassName="gap-6">
      <ul className="flex flex-col">
        {v.comparisons.map((c, i) => (
          <Row key={c.personaId} c={c} i={i} targeted={v.targetedPersonas.includes(c.personaId)} dense={v.comparisons.some((x) => x.regressions.length > 0)} />
        ))}
      </ul>
      <div className="mt-auto flex items-center gap-10 pt-2 pr-4">
        <Reveal delay={stampAt - 0.6} className="flex flex-1 items-center gap-4 rounded-2xl border p-5 text-2xl">
          <Info className="size-7 shrink-0 text-muted-foreground" aria-hidden />
          <p className="leading-snug">
            <span className="font-semibold">Poblaciones distintas.</span>{" "}
            <span className="text-muted-foreground">Un check direccional antes del merge, no un A/B test.</span>
          </p>
        </Reveal>
        <Stamp improved={v.improved} rehearsal={isRehearsal(a)} delay={stampAt} />
      </div>
      </FitBox>
    </div>
  );
}
