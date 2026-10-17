"use client";

import { Quote } from "lucide-react";
import { PERSONAS } from "@frictionswarm/shared";
import { OUTCOME, OutcomeBadge } from "@/components/bits";
import { PersonaAvatar } from "@/components/persona/avatar";
import { moodOf } from "@/lib/client/mood";
import { personaColor, personaShort } from "@/lib/format";
import type { AgentOutcome, AgentState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Shot } from "./screenshot";

function BudgetBar({ used, budget, personaId }: { used: number; budget: number; personaId: string }) {
  const frac = Math.min(1, budget ? used / budget : 0);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-r-full" style={{ width: `${frac * 100}%`, backgroundColor: personaColor(personaId) }} />
      </div>
      <span className="tabular text-xs text-muted-foreground">
        {used}/{budget} actions
      </span>
    </div>
  );
}

function AgentTile({ runId, a }: { runId: string; a: AgentState }) {
  const finished = a.state !== "running";
  const note = a.state === "gave-up" || a.state === "invalid" ? (a.outcomeNote ?? a.lastNote) : a.lastNote;
  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10 transition-opacity",
        a.state === "running" && "ring-2 ring-[var(--status-running)]/40",
      )}
      aria-label={`${personaShort(a.personaId)} seed ${a.seed}: ${OUTCOME[a.state].label}`}
    >
      <div className="relative">
        <Shot runId={runId} path={a.latestScreenshot} alt={`Latest screen for ${a.agentId}`} className="aspect-[16/10] w-full" />
        <OutcomeBadge state={a.state} className="absolute top-2 left-2 bg-background/90 shadow-sm backdrop-blur" />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium whitespace-nowrap">
            <PersonaAvatar personaId={a.personaId} mood={moodOf(a)} size={28} seed={a.seed} label="" />
            {personaShort(a.personaId)} <span className="text-muted-foreground">#{a.seed}</span>
          </span>
          <span className={cn("min-w-0 truncate text-right text-sm", finished ? "text-muted-foreground" : "font-medium")}>{a.step ?? "Starting…"}</span>
        </div>
        <BudgetBar used={a.actions} budget={a.budget} personaId={a.personaId} />
        {note ? (
          <p className="line-clamp-3 flex gap-1.5 text-sm leading-snug">
            <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="italic">{note}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No think-aloud yet</p>
        )}
      </div>
    </article>
  );
}

const ORDER: AgentOutcome[] = ["running", "success", "invalid", "gave-up", "stopped"];

export function LiveGrid({ runId, agents }: { runId: string; agents: AgentState[] }) {
  const personas = [...new Set(agents.map((a) => a.personaId))];
  return (
    <div className="flex flex-col gap-6">
      {personas.map((pid) => {
        const mine = agents.filter((a) => a.personaId === pid);
        const counts = ORDER.map((s) => [s, mine.filter((a) => a.state === s).length] as const).filter(([, n]) => n > 0);
        return (
          <section key={pid} className="flex flex-col gap-3" aria-label={`${personaShort(pid)} agents`}>
            <header className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <h3 className="flex items-center gap-2 text-lg font-semibold">
                <PersonaAvatar personaId={pid} size={36} label="" animate={false} />
                {PERSONAS[pid]?.name ?? pid}
              </h3>
              <span className="tabular text-muted-foreground">N={mine.length}</span>
              <span className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                {counts.map(([s, n]) => (
                  <span key={s} className="tabular">
                    {OUTCOME[s].label.toLowerCase()} {n}/{mine.length}
                  </span>
                ))}
              </span>
            </header>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {mine.map((a) => (
                <AgentTile key={a.agentId} runId={runId} a={a} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
