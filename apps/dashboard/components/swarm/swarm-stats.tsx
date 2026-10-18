"use client";

import { PersonaAvatar } from "@/components/persona/avatar";
import { useSwarmStats } from "@/lib/hooks/use-swarm-stats";
import { moodOf } from "@/lib/client/mood";
import { personaShort } from "@/lib/format";
import type { AgentState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MAP_TEXT, type MapSize, type MapText } from "./swarm-map";

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function Tile({ label, children, sub, size }: { label: string; children: React.ReactNode; sub?: React.ReactNode | false; size: MapSize }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("text-muted-foreground", size === "lg" ? "text-base" : "text-sm")}>{label}</span>
      <span className={cn("tabular leading-none font-semibold tracking-tight", size === "lg" ? "text-5xl" : "text-3xl")}>{children}</span>
      {sub && <span className={cn("tabular text-muted-foreground", size === "lg" ? "text-base" : "text-xs")}>{sub}</span>}
    </div>
  );
}

/** Live counters next to the map. Numbers use tabular figures so they don't
 * jitter as they tick. `minimal` keeps running / valid completion / elapsed, without sub-lines or persona counters. */
export function SwarmStatsRow({
  agents,
  live,
  size = "md",
  minimal,
  t = MAP_TEXT.en,
}: {
  agents: AgentState[];
  live?: boolean;
  size?: MapSize;
  minimal?: boolean;
  t?: MapText;
}) {
  const s = useSwarmStats(agents);
  const personas = [...new Set(agents.map((a) => a.personaId))];
  const rate = s.n ? s.valid / s.n : 0;
  return (
    <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
      <Tile label={t.running} size={size} sub={!minimal && t.done(s.done, s.n)}>
        <span className="inline-flex items-center gap-2">
          {live && s.running > 0 && (
            <span className="relative flex size-3" aria-hidden>
              <span className="absolute inline-flex size-full rounded-full bg-[var(--status-running)] opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex size-3 rounded-full bg-[var(--status-running)]" />
            </span>
          )}
          {s.running}
        </span>
      </Tile>
      {!minimal && (
        <Tile label={t.aps} size={size} sub={t.actionsTotal(s.actions)}>
          {s.aps.toFixed(1)}
        </Tile>
      )}
      <Tile label={t.valid} size={size} sub={!minimal && t.validSub(s.valid, s.n)}>
        {Math.round(rate * 100)}%
      </Tile>
      <Tile label={t.elapsed} size={size} sub={!minimal && t.swarmTime}>
        {clock(s.elapsedMs)}
      </Tile>
      {!minimal && (
      <div className="ml-auto flex flex-wrap items-end gap-x-6 gap-y-2">
        {personas.map((p) => {
          const mine = agents.filter((a) => a.personaId === p);
          const ok = mine.filter((a) => a.state === "success").length;
          const out = mine.filter((a) => a.state === "gave-up").length;
          const struggling = mine.filter((a) => moodOf(a) === "struggling").length;
          return (
            <div key={p} className="flex items-center gap-2">
              <PersonaAvatar personaId={p} mood={struggling ? "struggling" : ok === mine.length ? "success" : "running"} size={size === "lg" ? 52 : 36} label="" />
              <div className={cn("flex flex-col leading-tight", size === "lg" ? "text-lg" : "text-sm")}>
                <span className="font-semibold">{personaShort(p)}</span>
                <span className="tabular text-muted-foreground">
                  <span className="font-medium text-foreground">{ok}</span>/{mine.length} {t.checkedOutOf} · {out} {t.leftCount}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
