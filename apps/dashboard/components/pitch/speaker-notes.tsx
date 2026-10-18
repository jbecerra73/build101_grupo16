"use client";

import { Timer } from "lucide-react";
import { useNow } from "@/lib/hooks/use-poll";
import type { PitchData } from "./data";
import { mmss, SCENES, sceneStart } from "./scenes";

/** N: the presenter's notes for the current scene, with its time budget and the clocks. */
export function SpeakerNotes({ d, index, startedAt, sceneAt }: { d: PitchData; index: number; startedAt?: number; sceneAt: number }) {
  const now = useNow(500);
  const s = SCENES[index];
  const inScene = (now - sceneAt) / 1000;
  const total = startedAt ? (now - startedAt) / 1000 : 0;
  const plannedEnd = sceneStart(index) + s.seconds;
  const over = inScene > s.seconds;
  const next = SCENES[index + 1];
  return (
    <aside className="absolute top-8 right-8 bottom-24 flex w-[600px] flex-col gap-5 rounded-3xl border bg-popover/95 p-8 text-popover-foreground shadow-2xl backdrop-blur" aria-label="Notas del presentador">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-lg tracking-wide text-muted-foreground uppercase">Notas del presentador · {index + 1}/{SCENES.length}</span>
          <span className="text-3xl font-semibold">{s.title}</span>
        </div>
        <span className="tabular rounded-lg bg-muted px-3 py-1 text-2xl font-semibold">{s.seconds}s</span>
      </header>
      <div className="tabular grid grid-cols-2 gap-3 text-xl">
        <span className="flex flex-col rounded-xl border p-3">
          <span className="text-base text-muted-foreground">Esta escena</span>
          <span className="flex items-center gap-2 font-semibold" style={over ? { color: "var(--status-critical)" } : undefined}>
            <Timer className="size-5" aria-hidden />
            {mmss(inScene)} / {mmss(s.seconds)}
          </span>
        </span>
        <span className="flex flex-col rounded-xl border p-3">
          <span className="text-base text-muted-foreground">Reloj del pitch · plan</span>
          <span className="font-semibold">
            {startedAt ? mmss(total) : "–:–"} <span className="font-normal text-muted-foreground">· para {mmss(plannedEnd)}</span>
          </span>
        </span>
      </div>
      <ul className="flex min-h-0 flex-1 list-disc flex-col gap-3 overflow-y-auto pl-6 text-xl leading-snug">
        {s.notes(d).map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <footer className="flex flex-col gap-1 border-t pt-4 text-lg text-muted-foreground">
        {next && (
          <span>
            Siguiente: <span className="text-foreground">{next.title}</span> ({next.seconds}s)
          </span>
        )}
        <span>→ / Espacio siguiente · ← atrás · 1–7 saltar · R repetir escena · F pantalla completa · T tema · N ocultar · Esc salir</span>
      </footer>
    </aside>
  );
}
