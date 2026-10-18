"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { ChevronRight, CircleCheck, CircleX, DoorOpen, Lock, ShoppingBag, TriangleAlert } from "lucide-react";
import type { Flow, Metrics } from "@frictionswarm/shared";
import { PersonaAvatar } from "@/components/persona/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { moodOf, MOOD_LABEL } from "@/lib/client/mood";
import { personaShort } from "@/lib/format";
import type { AgentState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SwarmStatsRow } from "./swarm-stats";

export type MapSize = "md" | "lg";

type Dims = { avatar: number; pitch: number; dense: number; lane: number; perDenseRow: number };
/** Small swarms get big avatars; a full 30-agent swarm packs tighter. */
function dimsFor(size: MapSize, n: number): Dims {
  const small = n <= 12;
  if (size === "lg") return small ? { avatar: 72, pitch: 80, dense: 40, lane: 56, perDenseRow: 4 } : { avatar: 56, pitch: 62, dense: 34, lane: 44, perDenseRow: 5 };
  return small ? { avatar: 46, pitch: 52, dense: 26, lane: 40, perDenseRow: 4 } : { avatar: 36, pitch: 40, dense: 22, lane: 32, perDenseRow: 5 };
}
/** Above this many agents in one station they huddle (overlap) instead of wrapping. */
const CROWD = 9;
const BUBBLE_MS = 2800;
const MAX_BUBBLES = 4;

/** Funnel steps for the track: the analyzer's (or provisional) funnel, else the
 * flow's steps without side branches nobody reached. */
export function trackSteps(metrics: Metrics | undefined, flow: Flow | undefined, agents: AgentState[]): string[] {
  const fromMetrics = metrics?.personas[0]?.funnel.map((f) => f.step);
  if (fromMetrics?.length) return fromMetrics;
  const seen = new Set(agents.map((a) => a.step));
  if (flow) return flow.steps.map((s) => s.name).filter((n) => seen.has(n) || !/fail/i.test(n));
  return [...new Set(agents.map((a) => a.step).filter((s): s is string => !!s))];
}

const jitter = (seed: number, salt = 0) => ((Math.imul(seed * 31 + salt + 11, 2654435761) >>> 0) % 1000) / 1000;

type Fx = { miss?: number; bubble?: { text: string; key: number } };

/** Watches successive agent snapshots and emits transient effects: a missed tap
 * flashes, a new think-aloud pops a bubble for a moment. */
function useTransientFx(agents: AgentState[]) {
  const prev = useRef<Map<string, { missed: number; note?: string }> | null>(null);
  const [fx, setFx] = useState<Record<string, Fx>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const before = prev.current;
    const next = new Map(agents.map((a) => [a.agentId, { missed: a.missedActions, note: a.lastNote }]));
    prev.current = next;
    if (!before) return; // first snapshot: no effects for history
    const now = Date.now();
    const misses: string[] = [];
    const notes: [string, string][] = [];
    for (const a of agents) {
      const p = before.get(a.agentId);
      if (!p) continue;
      if (a.missedActions > p.missed) misses.push(a.agentId);
      if (a.lastNote && a.lastNote !== p.note && a.state === "running") notes.push([a.agentId, a.lastNote]);
    }
    if (!misses.length && !notes.length) return;
    setFx((cur) => {
      const out = { ...cur };
      for (const id of misses) out[id] = { ...out[id], miss: now + Math.random() };
      for (const [id, text] of notes) out[id] = { ...out[id], bubble: { text, key: now + Math.random() } };
      // cap concurrent bubbles: newest win
      const withBubble = Object.entries(out)
        .filter(([, f]) => f.bubble)
        .sort((x, y) => y[1].bubble!.key - x[1].bubble!.key);
      for (const [id] of withBubble.slice(MAX_BUBBLES)) out[id] = { ...out[id], bubble: undefined };
      return out;
    });
    for (const [id] of notes) {
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => setFx((cur) => ({ ...cur, [id]: { ...cur[id], bubble: undefined } })), BUBBLE_MS),
      );
    }
  }, [agents]);

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);
  return fx;
}

function AgentTip({ a }: { a: AgentState }) {
  const note = a.state === "gave-up" || a.state === "invalid" ? a.outcomeNote : a.lastNote;
  return (
    <div className="flex max-w-72 flex-col gap-1">
      <span className="font-semibold">
        {personaShort(a.personaId)} #{a.seed} · {MOOD_LABEL[moodOf(a)]}
      </span>
      <span className="tabular">
        {a.step ?? "Arriving"} · {a.actions}/{a.budget} actions{a.missedActions ? ` · ${a.missedActions} missed` : ""}
      </span>
      {note && <span className="italic">“{note}”</span>}
    </div>
  );
}

function MapAvatar({ a, size, fx, delay }: { a: AgentState; size: number; fx?: Fx; delay: number }) {
  const reduced = useReducedMotion();
  const mood = moodOf(a);
  return (
    <motion.div
      layoutId={a.agentId}
      layout="position"
      transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 170, damping: 22, delay }}
      className="relative"
      style={{ width: size, height: size, zIndex: fx?.bubble ? 30 : undefined }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="block rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/60" aria-label={`${personaShort(a.personaId)} #${a.seed}, ${MOOD_LABEL[mood]}, at ${a.step ?? "start"}`}>
            <PersonaAvatar personaId={a.personaId} mood={mood} size={size} seed={a.seed} label="" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <AgentTip a={a} />
        </TooltipContent>
      </Tooltip>
      {/* missed tap: a red ring bursts outward (transform + opacity only) */}
      <AnimatePresence>
        {fx?.miss && (
          <motion.span
            key={fx.miss}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full border-[3px] border-[var(--status-critical)]"
            initial={{ scale: 0.9, opacity: 1 }}
            animate={{ scale: 1.9, opacity: 0 }}
            transition={{ duration: reduced ? 0.01 : 0.9, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {fx?.miss && (
          <motion.span
            key={`m${fx.miss}`}
            aria-hidden
            className="pointer-events-none absolute -top-2 -right-3 rounded-full bg-[var(--status-critical)] px-1.5 text-[0.65rem] leading-4 font-bold text-white shadow"
            initial={{ opacity: 0, y: 4, scale: 0.8 }}
            animate={{ opacity: [0, 1, 1, 0], y: [4, -2, -2, -6], scale: 1 }}
            transition={{ duration: 1.4, times: [0, 0.15, 0.75, 1] }}
          >
            miss
          </motion.span>
        )}
      </AnimatePresence>
      {/* think-aloud bubble */}
      <AnimatePresence>
        {fx?.bubble && (
          <motion.div
            key={fx.bubble.key}
            role="status"
            className="pointer-events-none absolute bottom-full left-1/2 mb-2 w-max max-w-[14rem] origin-bottom rounded-xl bg-popover px-2.5 py-1.5 text-xs leading-snug text-popover-foreground shadow-lg ring-1 ring-foreground/10"
            style={{ x: "-50%" }}
            initial={{ opacity: 0, scale: 0.6, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: -4 }}
            transition={{ duration: reduced ? 0.01 : 0.25 }}
          >
            <span className="line-clamp-3 italic">“{fx.bubble.text}”</span>
            <span aria-hidden className="absolute top-full left-1/2 -ml-1.5 size-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-popover" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Station({
  label,
  required,
  agents,
  dims,
  height,
  fx,
  here,
  reached,
  left,
  n,
  first,
}: {
  label: string;
  required?: boolean;
  agents: AgentState[];
  dims: Dims;
  height: number;
  fx: Record<string, Fx>;
  here: number;
  reached?: number;
  left: number;
  n: number;
  first?: boolean;
}) {
  const crowded = agents.length > CROWD;
  const cell = crowded ? dims.dense : dims.pitch;
  const frac = n && reached !== undefined ? reached / n : 0;
  return (
    <li className="relative flex min-w-0 flex-col gap-2" aria-label={`${label}: ${here} here now${reached !== undefined ? `, ${reached} of ${n} reached` : ""}${left ? `, ${left} left here` : ""}`}>
      <div className="flex flex-col gap-1 px-1">
        <span className={cn("flex items-center gap-1 truncate text-sm font-semibold", first && "text-muted-foreground")}>
          {required && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="required step" />}
          {label}
        </span>
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className="tabular">
            <span className="text-base font-semibold text-foreground">{here}</span> here
          </span>
          {reached !== undefined && (
            <span className="tabular">
              {reached}/{n}
            </span>
          )}
          {left > 0 && (
            <span className="tabular flex items-center gap-0.5 font-medium text-foreground">
              <CircleX className="size-3" style={{ color: "var(--status-critical)" }} aria-hidden />
              {left}
            </span>
          )}
        </div>
        {/* reached / N: one neutral series, so ink not color */}
        <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full origin-left rounded-full bg-foreground/45 transition-transform duration-700" style={{ transform: `scaleX(${frac})` }} />
        </div>
      </div>
      <div
        className={cn("relative rounded-lg p-1.5", first ? "border border-dashed bg-transparent" : "bg-muted/50")}
        style={{ height }}
      >
        <div className="flex flex-wrap content-start" style={{ paddingTop: crowded ? dims.avatar - dims.dense : 0 }}>
          {agents.map((a) => (
            <div key={a.agentId} style={{ width: cell, height: crowded ? dims.dense : dims.pitch, marginTop: crowded ? -(dims.avatar - dims.dense) : 0 }} className="relative">
              <MapAvatar a={a} size={dims.avatar} fx={fx[a.agentId]} delay={jitter(a.seed, a.personaId.length) * 0.35} />
            </div>
          ))}
        </div>
      </div>
    </li>
  );
}

function Lane({
  icon,
  title,
  count,
  n,
  children,
  minHeight,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  n: number;
  children: React.ReactNode;
  minHeight: number;
  tone: string;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-3" style={{ minHeight }} aria-label={title}>
      <header className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-muted" style={{ color: tone }}>
          {icon}
        </span>
        <h3 className="font-semibold">{title}</h3>
        <span className="tabular text-muted-foreground">
          {count}/{n}
        </span>
      </header>
      {children}
    </section>
  );
}

export function SwarmMap({
  agents,
  metrics,
  flow,
  size = "md",
  live,
  caption,
  minimal,
}: {
  agents: AgentState[];
  metrics?: Metrics;
  flow?: Flow;
  size?: MapSize;
  /** Shows the live pulse in the stats row. */
  live?: boolean;
  caption?: React.ReactNode;
  /** Headline counters only (the pitch). */
  minimal?: boolean;
}) {
  const n = agents.length;
  const dims = dimsFor(size, n);
  const steps = useMemo(() => trackSteps(metrics, flow, agents), [metrics, flow, agents]);
  const required = new Set(flow?.required.steps ?? []);
  const fx = useTransientFx(agents);

  const reached = new Map<string, number>();
  const leftAt = new Map<string, number>();
  for (const p of metrics?.personas ?? []) {
    for (const f of p.funnel) {
      reached.set(f.step, (reached.get(f.step) ?? 0) + f.reached);
      leftAt.set(f.step, (leftAt.get(f.step) ?? 0) + f.droppedHere);
    }
  }

  const onTrack = agents.filter((a) => a.state === "running" || a.state === "stopped");
  const arriving = onTrack.filter((a) => !a.step || !steps.includes(a.step));
  const atStep = (s: string) => onTrack.filter((a) => a.step === s);
  const gaveUp = agents.filter((a) => a.state === "gave-up");
  const valid = agents.filter((a) => a.state === "success");
  const invalid = agents.filter((a) => a.state === "invalid");

  const groups = steps
    .map((s) => ({ step: s, agents: gaveUp.filter((a) => a.step === s) }))
    .concat([{ step: "Unknown step", agents: gaveUp.filter((a) => !a.step || !steps.includes(a.step)) }])
    .filter((g) => g.agents.length);

  // Station height is fixed from N, so nothing below moves as agents walk.
  const rows = Math.max(3, Math.ceil(n / dims.perDenseRow));
  const stationH = Math.max(3 * dims.pitch, rows * dims.dense + (dims.avatar - dims.dense)) + 12;
  const laneMin = size === "lg" ? 220 : 170;

  return (
    <div className="flex flex-col gap-5">
      <SwarmStatsRow agents={agents} live={live} size={size} minimal={minimal} />
      {caption}
      <LayoutGroup>
        <div className="-mx-1 overflow-x-auto px-1 pt-10 pb-1" role="region" aria-label="Swarm map: where each agent is in the funnel">
          <ol
            className="grid min-w-[1040px] gap-2"
            style={{ gridTemplateColumns: `minmax(0,0.8fr) ${steps.map(() => "minmax(0,1fr)").join(" ")}` }}
          >
            <Station label="Arriving" agents={arriving} dims={dims} height={stationH} fx={fx} here={arriving.length} left={0} n={n} first />
            {steps.map((s) => (
              <Station
                key={s}
                label={s}
                required={required.has(s)}
                agents={atStep(s)}
                dims={dims}
                height={stationH}
                fx={fx}
                here={atStep(s).length}
                reached={metrics ? (reached.get(s) ?? 0) : undefined}
                left={leftAt.get(s) ?? 0}
                n={n}
              />
            ))}
          </ol>
          <div className="mt-2 flex min-w-[1040px] items-center gap-1 text-xs text-muted-foreground" aria-hidden>
            <span>Store entrance</span>
            <span className="h-px flex-1 bg-border" />
            <ChevronRight className="size-3.5" />
            <span>Checkout</span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <Lane icon={<DoorOpen className="size-4" />} title="Left the store" count={gaveUp.length} n={n} minHeight={laneMin} tone="var(--status-critical)">
            {groups.length ? (
              <ul className="flex flex-col gap-3">
                {groups.map((g) => {
                  const quote = g.agents.findLast((a) => a.outcomeNote)?.outcomeNote;
                  return (
                    <li key={g.step} className="grid grid-cols-[7.5rem_1fr] items-start gap-3">
                      <span className="flex flex-col">
                        <span className="text-sm font-semibold">at {g.step}</span>
                        <span className="tabular text-xs text-muted-foreground">
                          {g.agents.length} agent{g.agents.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <div className="flex flex-wrap gap-1">
                          {g.agents.map((a) => (
                            <MapAvatar key={a.agentId} a={a} size={dims.lane} delay={0} />
                          ))}
                        </div>
                        {quote && <p className="line-clamp-2 text-sm italic">“{quote}”</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nobody has left yet. Agents who give up drop here with their reason.</p>
            )}
          </Lane>

          <Lane icon={<ShoppingBag className="size-4" />} title="Checked out" count={valid.length} n={n} minHeight={laneMin} tone="var(--status-good)">
            <div className="flex flex-col gap-3">
              {valid.length ? (
                <div className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <CircleCheck className="size-4" style={{ color: "var(--status-good)" }} aria-hidden />
                    Valid completions
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {valid.map((a) => (
                      <MapAvatar key={a.agentId} a={a} size={dims.lane} delay={0} />
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No valid completion yet.</p>
              )}
              {invalid.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-lg bg-muted/60 p-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <TriangleAlert className="size-4" style={{ color: "var(--status-warning)" }} aria-hidden />
                    Flagged: reached confirmation but invalid
                    <span className="tabular text-muted-foreground">{invalid.length}</span>
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {invalid.map((a) => (
                      <MapAvatar key={a.agentId} a={a} size={dims.lane} delay={0} />
                    ))}
                  </div>
                  {invalid[0].outcomeNote && <p className="text-xs text-muted-foreground">{invalid[0].outcomeNote}</p>}
                </div>
              )}
            </div>
          </Lane>
        </div>
      </LayoutGroup>
    </div>
  );
}
