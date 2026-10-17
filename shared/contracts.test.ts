import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionBudget,
  buyTshirt,
  isSwarm,
  PERSONAS,
  resolveStep,
  SEGMENTS,
  type Finding,
  type PostHogEvent,
  type RunConfig,
} from "./index";

const RUNS = join(__dirname, "..", "runs");
const readJson = <T>(...p: string[]): T => JSON.parse(readFileSync(join(RUNS, ...p), "utf8"));
const readEvents = (run: string): PostHogEvent[] =>
  readFileSync(join(RUNS, run, "posthog.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("resolveStep", () => {
  it.each([
    ["https://x.app/", "Home"],
    ["https://x.app/?swarm=r1", "Home"],
    ["/shop", "Browse"],
    ["/shop/product/1/T-shirt-with-Tape-Details", "Product"],
    ["/cart", "Cart"],
    ["/checkout/account", "Account"],
    ["/checkout", "Shipping"],
    ["/checkout?swarm=r1&step=payment", "Payment"],
    ["/checkout/success?swarm=r1", "Confirmation"],
    ["/about", undefined],
  ])("%s → %s", (url, step) => expect(resolveStep(buyTshirt, url)).toBe(step));
});

describe("actionBudget", () => {
  it("draws Kai's budget from 8–12 deterministically by seed", () => {
    const budgets = Array.from({ length: 50 }, (_, i) => actionBudget(PERSONAS.kai, i + 1));
    expect(Math.min(...budgets)).toBe(8);
    expect(Math.max(...budgets)).toBe(12);
    expect(actionBudget(PERSONAS.kai, 7)).toBe(actionBudget(PERSONAS.kai, 7));
  });
  it("uses maxActions when there is no range", () => {
    expect(actionBudget(PERSONAS.rosa, 3)).toBe(25);
  });
});

describe("demo flow", () => {
  it("required steps exist in the route map", () => {
    const names = buyTshirt.steps.map((s) => s.name);
    for (const s of buyTshirt.required.steps) expect(names).toContain(s);
  });
  it("every segment maps to a known persona", () => {
    for (const s of SEGMENTS) expect(PERSONAS[s.personaId]).toBeDefined();
  });
});

describe("fixture analysis run", () => {
  const config = readJson<RunConfig>("fixture-analysis", "config.json");
  const events = readEvents("fixture-analysis");

  it("is an analysis of real users only", () => {
    expect(config.kind).toBe("analysis");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(isSwarm)).toBe(false);
  });

  it("every $pageview resolves to a funnel step", () => {
    for (const e of events.filter((e) => e.event === "$pageview"))
      expect(resolveStep(buyTshirt, e.properties.$current_url!)).toBeDefined();
  });

  it("findings use the new shape and point at sessions in the snapshot", () => {
    const sessions = new Set(events.map((e) => e.properties.$session_id));
    for (const f of readJson<Finding[]>("fixture-analysis", "findings.json")) {
      expect(f.segments.length).toBeGreaterThan(0);
      expect(f.personas).toEqual(f.segments.map((s) => SEGMENTS.find((x) => x.id === s)!.personaId));
      for (const s of f.evidence.exampleSessions) expect(sessions.has(s)).toBe(true);
      expect(f.evidence.sessions).toBeGreaterThanOrEqual(f.evidence.exampleSessions.length);
    }
  });
});

describe("fixture retest run", () => {
  const config = readJson<RunConfig>("fixture-retest", "config.json");
  const events = readEvents("fixture-retest");

  it("is a swarm on the preview build, one session per configured agent", () => {
    expect(config.kind).toBe("retest");
    for (const e of events) {
      expect(e.properties.swarm_run).toBe(config.runId);
      expect(e.properties.build_sha).toBe(config.posthog.buildSha);
    }
    const agents = Object.entries(config.seeds).flatMap(([p, seeds]) => seeds.map((s) => `${p}-${s}`));
    expect(new Set(events.map((e) => e.properties.swarm_agent))).toEqual(new Set(agents));
    expect(new Set(events.map((e) => e.properties.$session_id)).size).toBe(agents.length);
  });

  it("agents narrate with swarm_* events", () => {
    expect(events.some((e) => e.event === "swarm_done" || e.event === "swarm_give_up")).toBe(true);
  });
});
