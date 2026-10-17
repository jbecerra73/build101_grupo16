import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { resolveStep, type Event, type Flow, type SwarmAgentResult, type SwarmEvent, type SwarmEventProperties } from "../shared";

type Base = Pick<Event, "runId" | "agentId" | "personaId" | "seed">;

export const ENDINGS = new Set<Event["type"]>(["success", "give_up", "error"]);

export const resultFile = (runDir: string, agentId: string) => join(runDir, "agents", `${agentId}.json`);

/** One agent's record. The storefront's own PostHog snippet captures its page views and clicks;
 * this sends the agent's narration and ending as `swarm_*` events through the page's
 * `window.posthog`, keeps the live-grid screenshot, and writes `agents/<agentId>.json` on the
 * ending. `events` is an in-memory trace for tests and debugging, never written to disk. */
export class AgentTrace {
  readonly events: Event[] = [];
  /** Whether the page had `window.posthog` the last time a swarm event was sent. */
  posthog?: boolean;
  private readonly startedAt = new Date().toISOString();
  private pending: Promise<unknown>[] = [];
  /** Set by the first ending; later events (e.g. from a call still in flight) are dropped. */
  private ended = false;

  constructor(
    private readonly page: Page,
    private readonly runDir: string,
    private readonly base: Base,
    private readonly flow: Flow,
    private readonly actions: () => number,
  ) {
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    mkdirSync(join(runDir, "agents"), { recursive: true });
  }

  /** `<agentId>-latest.png` for the dashboard's live grid (display only). */
  saveLatest(png: Buffer) {
    writeFileSync(join(this.runDir, "screenshots", `${this.base.agentId}-latest.png`), png);
  }

  emit(e: Omit<Event, keyof Base | "ts" | "step">): Event | undefined {
    if (this.ended) return undefined;
    const { type, url, ...rest } = e;
    this.ended = ENDINGS.has(type);
    const step = url ? resolveStep(this.flow, url) : undefined;
    const event: Event = { ...this.base, ts: Date.now(), type, url, step, ...rest };
    this.events.push(event);

    if (type === "think_aloud") this.capture("swarm_think_aloud", { note: e.note ?? "", step });
    if (type === "give_up") this.capture("swarm_give_up", { reason: e.note ?? "", step });
    // Only sent once the confirmation is on screen, so swarm_done is the done() evidence.
    if (type === "success") this.capture("swarm_done", { actions: this.actions() });
    if (this.ended) this.writeResult(event);
    return event;
  }

  /** Waits for swarm events still being handed to the page. */
  async flush() {
    await Promise.all(this.pending);
  }

  private capture<E extends SwarmEvent>(event: E, properties: SwarmEventProperties[E]) {
    const sent = this.page
      .evaluate(
        ([event, properties]) => {
          const ph = (window as { posthog?: { capture?: (...a: unknown[]) => unknown } }).posthog;
          if (typeof ph?.capture !== "function") return false;
          ph.capture(event, properties, { send_instantly: true });
          return true;
        },
        [event, properties] as const,
      )
      .then((ok) => {
        if (this.posthog !== false && !ok) console.error(`[${this.base.agentId}] no window.posthog on ${this.page.url()}; ${event} not sent`);
        this.posthog = ok;
      })
      .catch(() => {});
    this.pending.push(sent);
  }

  private writeResult(end: Event) {
    const result: SwarmAgentResult = {
      ...this.base,
      outcome: end.type as SwarmAgentResult["outcome"],
      actions: this.actions(),
      reason: end.type === "success" ? undefined : end.note,
      step: end.step,
      url: end.url,
      confirmation: end.confirmation,
      startedAt: this.startedAt,
      endedAt: new Date(end.ts).toISOString(),
    };
    writeFileSync(resultFile(this.runDir, this.base.agentId), JSON.stringify(result, null, 2) + "\n");
  }
}
