import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buyTshirt,
  PERSONAS,
  resolveStep,
  type Event,
  type Finding,
  type Metrics,
  type RunConfig,
} from "./index";

const RUN = join(__dirname, "..", "runs", "fixture-baseline");
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(RUN, f), "utf8"));
const events: Event[] = readdirSync(join(RUN, "events")).flatMap((f) =>
  readFileSync(join(RUN, "events", f), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l)),
);

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

describe("demo flow", () => {
  it("required steps exist in the route map", () => {
    const names = buyTshirt.steps.map((s) => s.name);
    for (const s of buyTshirt.required.steps) expect(names).toContain(s);
  });
});

describe("fixture run folder", () => {
  const config = readJson<RunConfig>("config.json");

  it("has one events file per configured agent", () => {
    const agents = Object.entries(config.seeds).flatMap(([p, seeds]) => seeds.map((s) => `${p}-${s}`));
    expect(readdirSync(join(RUN, "events")).sort()).toEqual(agents.map((a) => `${a}.jsonl`).sort());
  });

  it("events are consistent with config, personas and route map", () => {
    for (const e of events) {
      expect(e.runId).toBe(config.runId);
      expect(PERSONAS[e.personaId]).toBeDefined();
      expect(e.agentId).toBe(`${e.personaId}-${e.seed}`);
      if (e.url) expect(e.step).toBe(resolveStep(buyTshirt, e.url));
      if (e.screenshot) expect(existsSync(join(RUN, e.screenshot))).toBe(true);
    }
  });

  it("covers success, give-up, shortcut to confirmation and the control persona", () => {
    const byAgent = Map.groupBy(events, (e) => e.agentId);
    const ends = [...byAgent.values()].map((evs) => evs.at(-1)!);
    expect(ends.some((e) => e.type === "give_up")).toBe(true);
    expect(ends.some((e) => e.type === "success" && PERSONAS[e.personaId].control)).toBe(true);
    const shortcut = [...byAgent.values()].find(
      (evs) => evs.some((e) => e.type === "success") && !evs.some((e) => e.step === "Payment"),
    );
    expect(shortcut).toBeDefined();
  });

  it("metrics count the shortcut as an invalid completion", () => {
    const metrics = readJson<Metrics>("metrics.json");
    const kai = metrics.personas.find((p) => p.personaId === "kai")!;
    expect(kai).toMatchObject({ n: 2, completed: 0, gaveUp: 1, invalidCompletions: 1 });
    const typical = metrics.personas.find((p) => p.personaId === "typical")!;
    expect(typical.completionRate).toBe(1);
  });

  it("findings reference existing screenshots and known personas", () => {
    for (const f of readJson<Finding[]>("findings.json")) {
      for (const p of f.personas) expect(PERSONAS[p]).toBeDefined();
      for (const s of f.evidence.screenshots) expect(existsSync(join(RUN, s))).toBe(true);
    }
  });
});
