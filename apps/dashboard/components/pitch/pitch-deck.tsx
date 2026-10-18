"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getRun } from "@/lib/client/api";
import { isTerminal } from "@/lib/format";
import { usePoll } from "@/lib/hooks/use-poll";
import type { RunDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { pitchData, type PitchData } from "./data";
import { ScaledMotion, STAGE_H, STAGE_W } from "./parts";
import { SceneBeforeAfter } from "./scene-before-after";
import { SceneFix } from "./scene-fix";
import { ScenePostHog } from "./scene-posthog";
import { SceneProblem } from "./scene-problem";
import { SceneSwarm } from "./scene-swarm";
import { SceneTrust } from "./scene-trust";
import { SceneVision } from "./scene-vision";
import { mmss, SCENES, sceneStart, TOTAL_SECONDS } from "./scenes";
import { SpeakerNotes } from "./speaker-notes";

const POLL_MS = 1000;

/** Scale of the 1920×1080 stage in the window (letterboxed). */
function useStageScale() {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return scale;
}

/** Pitch mode is dark by default (T toggles); the site's own theme comes back on exit. */
function usePitchTheme(dark: boolean) {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const was = { dark: html.classList.contains("dark"), theme: html.dataset.theme, font: html.style.fontSize, overflow: document.body.style.overflow };
    // A slightly larger rem for the shared components (swarm map) on the 1920px stage.
    html.style.fontSize = "20px";
    document.body.style.overflow = "hidden";
    return () => {
      html.classList.toggle("dark", was.dark);
      if (was.theme) html.dataset.theme = was.theme;
      html.style.fontSize = was.font;
      document.body.style.overflow = was.overflow;
    };
  }, []);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
}

/** The analysis run and its re-test, polled while the pipeline is still running. */
function useLiveRuns(initial: RunDetail, initialRetest?: RunDetail) {
  const live = !isTerminal(initial.status.phase);
  const polled = usePoll(() => getRun(initial.runId), POLL_MS, live).data;
  const run = polled ?? initial;
  const stillLive = !isTerminal(run.status.phase);
  const retestId = run.status.retestRunId ?? run.fix?.attempts.at(-1)?.retestRunId;
  const polledRetest = usePoll(() => getRun(retestId!), POLL_MS, stillLive && !!retestId).data;
  const retest = polledRetest ?? (initialRetest?.runId === retestId ? initialRetest : undefined);
  return { run, retest, live: stillLive };
}

export function PitchDeck({ initial, initialRetest, startScene }: { initial: RunDetail; initialRetest?: RunDetail; startScene?: number }) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const scale = useStageScale();
  const [index, setIndex] = useState(() => (startScene && startScene >= 1 && startScene <= SCENES.length ? startScene - 1 : 0));
  const [dir, setDir] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [notes, setNotes] = useState(false);
  const [dark, setDark] = useState(true);
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [sceneAt, setSceneAt] = useState(() => Date.now());
  usePitchTheme(dark);

  const { run, retest, live } = useLiveRuns(initial, initialRetest);
  const d: PitchData = useMemo(() => pitchData(run, retest, live), [run, retest, live]);

  const go = useCallback(
    (to: number) => {
      const next = Math.max(0, Math.min(SCENES.length - 1, to));
      if (next === index) return;
      setDir(next > index ? 1 : -1);
      setIndex(next);
      setSceneAt(Date.now());
      setStartedAt((s) => s ?? Date.now());
    },
    [index],
  );

  // Keep ?scene= in the URL so a reload lands on the same scene.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("run", initial.runId);
    url.searchParams.set("scene", String(index + 1));
    window.history.replaceState(window.history.state, "", url);
  }, [index, initial.runId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === "ArrowRight" || k === " " || k === "PageDown" || k === "Enter") go(index + 1);
      else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace") go(index - 1);
      else if (k === "Home") go(0);
      else if (k === "End") go(SCENES.length - 1);
      else if (/^[1-9]$/.test(k) && Number(k) <= SCENES.length) go(Number(k) - 1);
      else if (k === "r" || k === "R") {
        setNonce((n) => n + 1);
        setSceneAt(Date.now());
      } else if (k === "n" || k === "N") setNotes((v) => !v);
      else if (k === "t" || k === "T") setDark((v) => !v);
      else if (k === "f" || k === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.().catch(() => {});
      } else if (k === "Escape") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else router.push(`/runs/${initial.runId}`);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, router, initial.runId]);

  const scene = SCENES[index];
  const body = (() => {
    switch (scene.id) {
      case "problem":
        return <SceneProblem d={d} />;
      case "posthog":
        return <ScenePostHog d={d} index={index} />;
      case "fix":
        return <SceneFix d={d} index={index} />;
      case "swarm":
        return <SceneSwarm d={d} index={index} />;
      case "before-after":
        return <SceneBeforeAfter d={d} index={index} />;
      case "trust":
        return <SceneTrust d={d} index={index} />;
      case "vision":
        return <SceneVision d={d} />;
    }
  })();

  const variants = {
    enter: (dr: number) => (reduced ? { opacity: 0 } : { opacity: 0, x: dr * 80 }),
    center: { opacity: 1, x: 0 },
    exit: (dr: number) => (reduced ? { opacity: 0 } : { opacity: 0, x: dr * -80 }),
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-background text-foreground" role="region" aria-roledescription="presentation" aria-label="Pitch de FrictionSwarm" lang="es">
      <div
        className="absolute top-1/2 left-1/2 origin-center"
        style={{ width: STAGE_W, height: STAGE_H, transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <ScaledMotion scale={scale}>
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.section
            key={`${scene.id}-${nonce}`}
            custom={dir}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: reduced ? 0.15 : 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 px-24 pt-14 pb-24"
            aria-label={`Escena ${index + 1} de ${SCENES.length}: ${scene.title}`}
          >
            {body}
          </motion.section>
        </AnimatePresence>
        </ScaledMotion>

        <Progress index={index} onJump={go} />
        {notes && <SpeakerNotes d={d} index={index} startedAt={startedAt} sceneAt={sceneAt} />}
      </div>
    </div>
  );
}

/** Thin bottom bar: one segment per scene, as wide as its time budget. */
function Progress({ index, onJump }: { index: number; onJump: (i: number) => void }) {
  return (
    <nav className="absolute right-24 bottom-8 left-24 flex items-center gap-6" aria-label="Escenas">
      <span className="tabular w-56 shrink-0 text-lg text-muted-foreground">
        {index + 1}/{SCENES.length} · {SCENES[index].title}
      </span>
      <ol className="flex flex-1 gap-1.5">
        {SCENES.map((s, i) => (
          <li key={s.id} style={{ flexGrow: s.seconds }} className="basis-0">
            <button
              type="button"
              onClick={() => onJump(i)}
              className="group block w-full py-2 outline-none"
              aria-label={`Escena ${i + 1}: ${s.title}, ${s.seconds}s`}
              aria-current={i === index ? "step" : undefined}
            >
              <span className={cn("block h-1.5 rounded-full transition-colors", i < index ? "bg-foreground/45" : i === index ? "bg-foreground" : "bg-muted group-hover:bg-foreground/25")} />
            </button>
          </li>
        ))}
      </ol>
      <span className="tabular w-56 shrink-0 text-right text-lg text-muted-foreground">
        {mmss(sceneStart(index))}–{mmss(sceneStart(index) + SCENES[index].seconds)} de {mmss(TOTAL_SECONDS)} · N notas
      </span>
    </nav>
  );
}
