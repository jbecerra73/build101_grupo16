"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const SPEEDS = [1, 2, 4, 8, 16] as const;

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function ReplayControls({
  playing,
  onPlayingChange,
  speed,
  onSpeedChange,
  position,
  length,
  onSeek,
  eventsShown,
  eventsTotal,
}: {
  playing: boolean;
  onPlayingChange: (p: boolean) => void;
  speed: number;
  onSpeedChange: (s: number) => void;
  position: number;
  length: number;
  onSeek: (ms: number) => void;
  eventsShown: number;
  eventsTotal: number;
}) {
  const atEnd = position >= length;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
      <Badge variant="secondary" className="uppercase tracking-wide">
        Replay
      </Badge>
      <div className="flex items-center gap-1">
        <Button
          size="icon-lg"
          onClick={() => {
            if (atEnd) onSeek(0);
            onPlayingChange(atEnd ? true : !playing);
          }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button
          size="icon-lg"
          variant="ghost"
          onClick={() => {
            onSeek(0);
            onPlayingChange(true);
          }}
          aria-label="Restart"
        >
          <RotateCcw />
        </Button>
      </div>
      <div className="flex min-w-60 flex-1 items-center gap-3">
        <span className="tabular w-12 text-right text-sm">{clock(position)}</span>
        <Slider
          aria-label="Replay position"
          min={0}
          max={Math.max(1, length)}
          step={100}
          value={[Math.min(position, length)]}
          onValueChange={([v]) => onSeek(v)}
          className="flex-1"
        />
        <span className="tabular w-12 text-sm text-muted-foreground">{clock(length)}</span>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        value={String(speed)}
        onValueChange={(v) => v && onSpeedChange(Number(v))}
        aria-label="Playback speed"
      >
        {SPEEDS.map((s) => (
          <ToggleGroupItem key={s} value={String(s)} className="tabular px-2.5">
            {s}×
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span className="tabular text-sm text-muted-foreground">
        {eventsShown}/{eventsTotal} events
      </span>
    </div>
  );
}
