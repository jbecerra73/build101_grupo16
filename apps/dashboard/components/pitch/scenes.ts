import { pct1, signedPts } from "@/lib/format";
import { personaEs, segmentEs } from "./es";
import type { PitchData } from "./data";

export type SceneId = "problem" | "posthog" | "fix" | "swarm" | "before-after" | "trust" | "vision";

export type SceneMeta = {
  id: SceneId;
  title: string;
  /** Time budget in the 3-minute pitch (SPEC: Pitch). */
  seconds: number;
  notes: (d: PitchData) => string[];
};

export const SCENES: SceneMeta[] = [
  {
    id: "problem",
    title: "Problema",
    seconds: 20,
    notes: (d) => {
      const worst = d.impacts.toSorted((a, b) => a.deltaPts - b.deltaPts)[0];
      return [
        "Los POs shipean cambios al checkout a ciegas: nadie mira cada segmento después de un release.",
        worst
          ? `En esta tienda, “${worst.release.name}” bajó la completion de ${segmentEs(worst.segmentId)} de ${pct1(worst.before)} a ${pct1(worst.after)}, y nadie lo notó durante semanas.`
          : "La fricción aparece como drop-off en analytics, semanas después del release que la causó.",
        "Para entonces los clientes reales ya se fueron. Un A/B test necesita semanas de tráfico para decir algo.",
      ];
    },
  },
  {
    id: "posthog",
    title: "Seis meses de PostHog",
    seconds: 40,
    notes: (d) => [
      "Estos son los datos reales de PostHog de la tienda: completion semanal del checkout por segmento, solo usuarios reales.",
      "Las líneas verticales son releases a producción. Esperen los anillos: cada uno marca el release que rompió un segmento.",
      ...d.impacts.map((i) => `${segmentEs(i.segmentId)} se rompió con “${i.release.name}”: ${pct1(i.before)} → ${pct1(i.after)}.`),
      `El analyzer convierte eso en ${d.findings.length} findings, cada uno con su evidencia y el release que lo introdujo.`,
    ],
  },
  {
    id: "fix",
    title: "El fix",
    seconds: 30,
    notes: (d) => [
      `Los findings principales van a un coding agent (Claude Code, headless) con el repo del storefront; hace push de un branch y abre un draft PR.`,
      d.attempt?.findingIds.length ? `Atacó ${d.attempt.findingIds.join(" y ")}.` : "Ataca los 1–3 findings principales.",
      "Si el badge dice rehearsal, díganlo claro: en el escenario el fix loop está grabado, el resto es el mismo pipeline.",
      "Netlify construye un deploy preview; el orquestador espera a que el preview sirva el commit pusheado.",
    ],
  },
  {
    id: "swarm",
    title: "Re-test del swarm",
    seconds: 30,
    notes: (d) => [
      d.live ? "Esto es en vivo: el swarm está comprando en el preview ahora mismo." : "Reproducido desde el snapshot de PostHog del re-test, acelerado.",
      "Cada cara es un agent con las restricciones de una persona aplicadas: Rosa ve una pantalla borrosa y reducida; Kai falla los taps de menos de 44px.",
      "Recorren el funnel de izquierda a derecha. Los que se rinden caen en ‘Salieron de la tienda’ con su motivo; las órdenes válidas llegan a ‘Checkout completo’.",
      `${d.retest?.agents.length ?? 30} agents, seeds nuevos, etiquetados para que nunca toquen las métricas de usuarios reales.`,
    ],
  },
  {
    id: "before-after",
    title: "Antes / después",
    seconds: 30,
    notes: (d) => {
      const v = d.attempt?.verdict;
      if (!v) return ["El veredicto aparece cuando se comparan los tracks del swarm. Si sigue corriendo, vuelvan al swarm."];
      return [
        "Antes: los usuarios reales del segmento en producción. Después: el persona swarm en el preview. N en ambos lados.",
        ...v.comparisons.map((c) => `${segmentEs(c.segmentId)} ↔ ${personaEs(c.personaId)}: ${signedPts(c.completionDeltaPts)}${c.regressions.length ? ` (regresiones: ${c.regressions.length})` : ""}.`),
        "Poblaciones distintas: un check direccional antes del merge, no un A/B test.",
        v.improved ? "Probado contra el umbral: el PR queda listo para review." : "No probado: el PR recibe un comentario con las métricas, el label not-proven y se cierra. Mostramos los fallos con honestidad.",
      ];
    },
  },
  {
    id: "trust",
    title: "Por qué confiar",
    seconds: 20,
    notes: () => [
      "Primero la evidencia: los findings vienen de usuarios reales en PostHog, no de los agents.",
      "Los límites de las personas se aplican sobre lo que el modelo ve y puede hacer, no solo en el prompt: esa es la vista de Rosa y la grilla de 44px de Kai.",
      "La persona de control no debe empeorar; los re-tests usan seeds nuevos; una completion necesita los pasos obligatorios, así que los atajos no cuentan.",
      "En el historial con trampas plantadas, encontró las cinco trampas y el release que introdujo cada una.",
    ],
  },
  {
    id: "vision",
    title: "Visión",
    seconds: 10,
    notes: () => ["CI para UX: cada PR del storefront se verifica con evidencia de usuarios reales más un persona swarm, antes de que lo vea cualquier cliente.", "Gracias."],
  },
];

export const TOTAL_SECONDS = SCENES.reduce((n, s) => n + s.seconds, 0);

/** Start offset of a scene in the pitch, in seconds. */
export const sceneStart = (i: number) => SCENES.slice(0, i).reduce((n, s) => n + s.seconds, 0);

export const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
