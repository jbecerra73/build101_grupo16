"use client";

import { useId } from "react";
import { motion, useReducedMotion, type TargetAndTransition, type Transition } from "motion/react";
import { personaColor, personaShort } from "@/lib/format";
import { MOOD_LABEL, type Mood } from "@/lib/client/mood";
import { cn } from "@/lib/utils";

const SKIN = "#f1c6a2";
const SKIN_SHADE = "#d9a47f";
const INK = "#1b1b24";

/* ------------------------------------------------------------ face parts */

function Eyes({ mood, big }: { mood: Mood; big?: boolean }) {
  const r = big ? 1.35 : 1.2;
  if (mood === "gave-up")
    return (
      <g stroke={INK} strokeWidth={1.3} fill="none" strokeLinecap="round">
        <path d="M18.8 22.4 q1.4 1 2.8 0" />
        <path d="M26.4 22.4 q1.4 1 2.8 0" />
      </g>
    );
  if (mood === "success")
    return (
      <g stroke={INK} strokeWidth={1.4} fill="none" strokeLinecap="round">
        <path d="M18.8 22.6 q1.4 -1.7 2.8 0" />
        <path d="M26.4 22.6 q1.4 -1.7 2.8 0" />
      </g>
    );
  return (
    <g fill={INK}>
      <circle cx={20.2} cy={22} r={r} />
      <circle cx={27.8} cy={22} r={r} />
    </g>
  );
}

function Mouth({ mood }: { mood: Mood }) {
  const common = { stroke: INK, strokeWidth: 1.4, fill: "none", strokeLinecap: "round" as const };
  switch (mood) {
    case "success":
      return <path d="M20.6 25.9 Q24 30.6 27.4 25.9 Z" fill={INK} />;
    case "struggling":
      return <path d="M20.8 27.4 q1.6 -1.4 3.2 0 t3.2 0" {...common} />;
    case "gave-up":
      return <path d="M21 28.3 Q24 25.8 27 28.3" {...common} />;
    case "invalid":
      return <path d="M21.2 27 H26.8" {...common} />;
    default:
      return <path d="M21 26.4 Q24 28.4 27 26.4" {...common} />;
  }
}

function Brows({ mood }: { mood: Mood }) {
  if (mood !== "struggling") return null;
  return (
    <g stroke={INK} strokeWidth={1.1} strokeLinecap="round">
      <path d="M18.6 18.6 l3 -1" />
      <path d="M29.4 18.6 l-3 -1" />
      {/* sweat drop */}
      <path d="M35.6 12.4 q2.3 3.3 0 4.7 q-2.3 -1.4 0 -4.7 Z" fill="#7cc8f2" stroke="white" strokeWidth={0.6} />
    </g>
  );
}

function StatusBadge({ mood }: { mood: Mood }) {
  if (mood === "success")
    return (
      <g>
        <circle cx={8} cy={8} r={7} fill="var(--status-good)" stroke="white" strokeWidth={1.5} />
        <path d="M4.8 8.2 l2.2 2.2 l4.2 -4.6" stroke="white" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    );
  if (mood === "invalid")
    return (
      <g>
        <path d="M8 1 L15.5 14.5 H0.5 Z" fill="var(--status-warning)" stroke="white" strokeWidth={1.3} strokeLinejoin="round" />
        <path d="M8 5.6 V9.6" stroke={INK} strokeWidth={1.8} strokeLinecap="round" />
        <circle cx={8} cy={12} r={1} fill={INK} />
      </g>
    );
  if (mood === "gave-up")
    return (
      <g>
        <circle cx={8} cy={8} r={7} fill="var(--status-critical)" stroke="white" strokeWidth={1.5} />
        <path d="M5.4 5.4 l5.2 5.2 M10.6 5.4 l-5.2 5.2" stroke="white" strokeWidth={1.8} strokeLinecap="round" />
      </g>
    );
  return null;
}

/* -------------------------------------------------------- persona figures */

function Rosa({ mood, motif }: { mood: Mood; motif: boolean }) {
  if (motif)
    return (
        // large-type motif
        <g>
          <rect x={0.8} y={31.5} width={17.5} height={13.5} rx={3.5} fill="white" stroke="var(--fs-c)" strokeWidth={1.6} />
          <text x={9.6} y={41.8} textAnchor="middle" fontSize={10} fontWeight={800} fill={INK} fontFamily="system-ui, sans-serif">
            Aa
          </text>
        </g>
    );
  return (
    <>
      {/* cardigan */}
      <path d="M5 50 C7 37.5 15 33.5 24 33.5 C33 33.5 41 37.5 43 50 Z" fill="#f4f1fb" />
      <path d="M24 33.5 L21 50 M24 33.5 L27 50" stroke="#c9c2dc" strokeWidth={1.2} />
      <rect x={21} y={28} width={6} height={6.5} rx={2} fill={SKIN_SHADE} />
      <circle cx={24} cy={21.5} r={9.6} fill={SKIN} />
      {/* silver hair with a bun */}
      <circle cx={24} cy={9} r={4.3} fill="#e6e8ef" stroke="#a3a8b8" strokeWidth={0.7} />
      <path
        d="M14.2 22 C13.4 13 18.6 10.6 24 10.6 C29.4 10.6 34.6 13 33.8 22 C32.6 17 29.6 15 24 15 C18.4 15 15.4 17 14.2 22 Z"
        fill="#e6e8ef"
        stroke="#a3a8b8"
        strokeWidth={0.7}
      />
      <Brows mood={mood} />
      <Eyes mood={mood} big />
      {/* big round reading glasses */}
      <g stroke={INK} strokeWidth={1.5} fill="white" fillOpacity={0.28}>
        <circle cx={20.2} cy={22} r={3.8} />
        <circle cx={27.8} cy={22} r={3.8} />
      </g>
      <path d="M16.4 21.4 L14.6 20.6 M31.6 21.4 L33.4 20.6" stroke={INK} strokeWidth={1.1} strokeLinecap="round" />
      <Mouth mood={mood} />
    </>
  );
}

function Kai({ mood, motif }: { mood: Mood; motif: boolean }) {
  if (motif)
    return (
        // lightning motif
        <g>
          <circle cx={40} cy={8} r={7.2} fill="#ffd23d" stroke="white" strokeWidth={1.4} />
          <path d="M41.2 3.2 L36.4 9 H39.8 L38.6 13 L43.6 7 H40.2 Z" fill={INK} strokeLinejoin="round" />
        </g>
    );
  return (
    <>
      {/* hoodie */}
      <path d="M5 50 C7 37.5 15 33.5 24 33.5 C33 33.5 41 37.5 43 50 Z" fill="#252a3a" />
      <path d="M21.5 34.5 v5 M26.5 34.5 v5" stroke="#cfd5e4" strokeWidth={1} strokeLinecap="round" />
      <rect x={21} y={28} width={6} height={6.5} rx={2} fill={SKIN_SHADE} />
      <circle cx={24} cy={21.5} r={9.6} fill={SKIN} />
      {/* spiky hair */}
      <path
        d="M14.3 21 L14.6 13.4 L17.8 15 L18.6 9.6 L22.2 13 L24.6 8.2 L26.8 12.6 L30.4 9.4 L31 14.2 L34 13.2 L33.7 21 C31.4 17 28.2 16 24 16 C19.8 16 16.6 17 14.3 21 Z"
        fill="#1e1b2e"
      />
      <Brows mood={mood} />
      <Eyes mood={mood} />
      <Mouth mood={mood} />
      {/* phone in hand */}
      <rect x={29.6} y={31.6} width={8.6} height={14} rx={1.8} fill="#11131a" stroke="white" strokeWidth={0.9} />
      <rect x={30.9} y={33.2} width={6} height={10.2} rx={0.8} fill="#a5e4ff" />
      <circle cx={30.4} cy={42} r={2.4} fill={SKIN} />
    </>
  );
}

function Typical({ mood, motif }: { mood: Mood; motif: boolean }) {
  if (motif)
    return (
        // shopping-bag motif (the control shopper)
        <g>
          <path d="M5.6 35 v-2.2 a3.4 3.4 0 0 1 6.8 0 V35" stroke={INK} strokeWidth={1.4} fill="none" />
          <rect x={2.2} y={34.4} width={13.6} height={11} rx={2.4} fill="white" stroke="var(--fs-c)" strokeWidth={1.6} />
        </g>
    );
  return (
    <>
      <path d="M5 50 C7 37.5 15 33.5 24 33.5 C33 33.5 41 37.5 43 50 Z" fill="#eef2f6" />
      <path d="M20.5 34 L24 38 L27.5 34" stroke="#b9c3cf" strokeWidth={1.2} fill="none" />
      <rect x={21} y={28} width={6} height={6.5} rx={2} fill={SKIN_SHADE} />
      <circle cx={24} cy={21.5} r={9.6} fill={SKIN} />
      <path
        d="M14.4 20.6 C14.4 13.4 18.4 10.8 24 10.8 C29.6 10.8 33.6 13.4 33.6 20.6 C31.2 17.2 27.8 16.2 24 16.2 C20.2 16.2 16.8 17.2 14.4 20.6 Z"
        fill="#5b3a29"
      />
      <Brows mood={mood} />
      <Eyes mood={mood} />
      <Mouth mood={mood} />
    </>
  );
}

const FIGURES: Record<string, (p: { mood: Mood; motif: boolean }) => React.ReactNode> = { rosa: Rosa, kai: Kai, typical: Typical };

/* ------------------------------------------------------------------ motion */

const jitter = (seed: number) => ((Math.imul(seed + 7, 2654435761) >>> 0) % 1000) / 1000;

/** One-shot state changes run on motion; the idle loops (bob, wobble) are CSS
 * keyframes in globals.css (cheap, compositor-only, and paused by
 * prefers-reduced-motion). */
function moodMotion(mood: Mood): { animate: TargetAndTransition; transition: Transition } {
  switch (mood) {
    case "gave-up":
      return { animate: { y: 3, rotate: -12, scale: 0.94, opacity: 0.62 }, transition: { duration: 0.6, ease: "easeOut" } };
    case "success":
      return { animate: { scale: [0.7, 1.2, 1], y: 0, rotate: 0, opacity: 1 }, transition: { duration: 0.55, ease: "easeOut" } };
    case "invalid":
      return { animate: { scale: 1, y: 0, rotate: [0, -6, 6, 0], opacity: 1 }, transition: { duration: 0.5 } };
    default:
      return { animate: { y: 0, rotate: 0, scale: 1, opacity: 1 }, transition: { duration: 0.3 } };
  }
}

export function PersonaAvatar({
  personaId,
  mood = "idle",
  size = 40,
  seed = 0,
  className,
  label,
  animate = true,
  ring,
}: {
  personaId: string;
  mood?: Mood;
  size?: number;
  seed?: number;
  className?: string;
  /** Accessible label; defaults to "<Persona>, <mood>". Pass "" to hide from assistive tech. */
  label?: string;
  /** false = static (e.g. inside dense tables). */
  animate?: boolean;
  /** Draws a ring in the persona color (selected / spotlight). */
  ring?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const Figure = FIGURES[personaId];
  const color = personaColor(personaId);
  const motif = size >= 26;
  const status = size >= 18;
  const aria = label ?? `${personaShort(personaId)}, ${MOOD_LABEL[mood]}`;
  const { animate: target, transition } = moodMotion(mood);
  const j = jitter(seed);
  const loop = !animate ? undefined : mood === "running" ? "fs-bob" : mood === "struggling" ? "fs-wobble" : undefined;
  const still = !animate || reduced;

  const svg = (
    <svg
      viewBox="-1 -1 50 50"
      width={size}
      height={size}
      className="block"
      style={{ ["--fs-c" as string]: color }}
      role={aria ? "img" : undefined}
      aria-label={aria || undefined}
      aria-hidden={aria ? undefined : true}
    >
      <defs>
        <clipPath id={`c${uid}`}>
          <circle cx={24} cy={24} r={24} />
        </clipPath>
      </defs>
      <circle cx={24} cy={24} r={24} fill={color} />
      {ring && <circle cx={24} cy={24} r={25.5} fill="none" stroke={color} strokeWidth={2} />}
      {Figure ? (
        <>
          <g clipPath={`url(#c${uid})`}>
            <Figure mood={mood} motif={false} />
          </g>
          {/* motif badges overflow the disc on purpose */}
          {motif && (
            <g>
              <Figure mood={mood} motif />
            </g>
          )}
        </>
      ) : (
        <text x={24} y={30} textAnchor="middle" fontSize={18} fontWeight={700} fill="white" fontFamily="system-ui, sans-serif">
          {personaId.slice(0, 1).toUpperCase()}
        </text>
      )}
      {status && <StatusBadge mood={mood} />}
    </svg>
  );

  // Same element on server and client (useReducedMotion is only known after hydration).
  return (
    <motion.span
      className={cn("inline-block shrink-0 origin-bottom", className)}
      style={{ width: size, height: size }}
      initial={false}
      animate={still ? { y: 0, rotate: 0, scale: 1, opacity: mood === "gave-up" ? 0.62 : 1 } : target}
      transition={still ? { duration: 0 } : transition}
    >
      <span
        className={cn("block size-full origin-bottom", loop)}
        style={loop ? { animationDelay: `-${(j * 2).toFixed(2)}s`, animationDuration: loop === "fs-bob" ? `${(1.3 + j * 0.6).toFixed(2)}s` : undefined } : undefined}
      >
        {svg}
      </span>
    </motion.span>
  );
}
