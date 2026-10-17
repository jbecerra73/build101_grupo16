import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStep, type Event, type Flow } from "../shared";

type Base = Pick<Event, "runId" | "agentId" | "personaId" | "seed">;

export const ENDINGS = new Set<Event["type"]>(["success", "give_up", "error"]);

/** Appends Events to `events/<agentId>.jsonl` and screenshots to `screenshots/` in a run folder. */
export class EventLog {
  readonly events: Event[] = [];
  private shot = 0;
  /** Set by the first ending; later events (e.g. from a call still in flight) are dropped. */
  private ended = false;

  constructor(
    private readonly runDir: string,
    private readonly base: Base,
    private readonly flow: Flow,
  ) {
    mkdirSync(join(runDir, "events"), { recursive: true });
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    writeFileSync(this.file, "");
  }

  private get file() {
    return join(this.runDir, "events", `${this.base.agentId}.jsonl`);
  }

  /** Saves a numbered screenshot plus `<agentId>-latest.png` for the live grid. */
  saveScreenshot(png: Buffer): string {
    const rel = `screenshots/${this.base.agentId}-${String(this.shot++).padStart(3, "0")}.png`;
    writeFileSync(join(this.runDir, rel), png);
    this.saveLatest(png);
    return rel;
  }

  saveLatest(png: Buffer) {
    writeFileSync(join(this.runDir, "screenshots", `${this.base.agentId}-latest.png`), png);
  }

  emit(e: Omit<Event, keyof Base | "ts" | "step">): Event | undefined {
    if (this.ended) return undefined;
    const { type, url, ...rest } = e;
    this.ended = ENDINGS.has(type);
    const event: Event = {
      ...this.base,
      ts: Date.now(),
      type,
      url,
      step: url ? resolveStep(this.flow, url) : undefined,
      ...rest,
    };
    this.events.push(event);
    appendFileSync(this.file, JSON.stringify(event) + "\n");
    return event;
  }
}
