// Route handlers against an in-memory run store (no orchestrator running).
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunStatus, StartRunRequest } from "@frictionswarm/shared";
import { MemoryStore, type QueuedRun } from "@frictionswarm/store";

process.env.ORCHESTRATOR = "daemon"; // never start the inline orchestrator here
process.env.RUNS_DIR = "/nonexistent/frictionswarm-test-runs";

const { setRunStore } = await import("./store");
const runs = await import("@/app/api/runs/route");
const runDetail = await import("@/app/api/runs/[id]/route");
const files = await import("@/app/api/runs/[id]/files/[...path]/route");
const swarm = await import("@/app/api/runs/[id]/swarm/route");
const cancel = await import("@/app/api/runs/[id]/cancel/route");
const retry = await import("@/app/api/runs/[id]/retry/route");
const control = await import("@/app/api/control/route");
const settings = await import("@/app/api/settings/route");
const flowsRoute = await import("@/app/api/flows/route");
const flowRoute = await import("@/app/api/flows/[id]/route");
const flowValidate = await import("@/app/api/flows/validate/route");
const personasRoute = await import("@/app/api/personas/route");
const fix = await import("@/app/api/runs/[id]/fix/route");
const decision = await import("@/app/api/runs/[id]/decision/route");

const req: StartRunRequest = { flowId: "buy-tshirt", window: { from: "2026-09-19", to: "2026-10-17" }, source: "file", seedsPerPersona: 2, autoFix: true };
const url = (p: string) => `http://localhost${p}`;
const post = (p: string, body?: unknown) =>
  new NextRequest(url(p), { method: "POST", body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const put = (p: string, body: unknown) => new NextRequest(url(p), { method: "PUT", body: JSON.stringify(body) });
const get = (p: string) => new NextRequest(url(p));
// Next passes params as a promise; the generated RouteContext types are not needed here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, unknown>): any => ({ params: Promise.resolve(params) });

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setRunStore(store);
});

const seedRun = async (runId: string, phase: RunStatus["phase"], extra: Record<string, unknown> = {}) => {
  await store.putJson(`runs/${runId}/config.json`, {
    runId, kind: "analysis", flowId: "buy-tshirt", window: { from: "2026-09-01", to: "2026-09-29" }, posthog: { source: "file", buildSha: "abc" },
    personaIds: [], seeds: {}, targetUrl: "https://example.com", createdAt: new Date().toISOString(), ...extra,
  });
  await store.putJson(`runs/${runId}/status.json`, { runId, phase, updatedAt: new Date().toISOString() });
};

describe("POST /api/runs (enqueue)", () => {
  it("queues a QueuedRun with a pre-assigned runId", async () => {
    const res = await runs.POST(post("/api/runs", req));
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const keys = await store.list("queue/");
    expect(keys).toHaveLength(1);
    const q = (await store.getJson<QueuedRun>(keys[0]))!;
    expect(q).toMatchObject({ runId, req });
    // the run page can show it before the orchestrator takes it
    const detail = await runDetail.GET(get(`/api/runs/${runId}`), ctx({ id: runId }));
    expect(detail.status).toBe(200);
    expect((await detail.json()).status).toMatchObject({ phase: "analyzing", message: "Queued: waiting for the orchestrator" });
  });

  it("rejects invalid bodies with the validation errors", async () => {
    const bad = await runs.POST(post("/api/runs", { ...req, seedsPerPersona: 99 }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors[0]).toMatch(/seedsPerPersona/);
    const badWindow = await runs.POST(post("/api/runs", { ...req, window: { from: "2026-10-17", to: "2026-10-01" }, source: "s3" }));
    expect((await badWindow.json()).errors).toEqual(["window.from must be before window.to", "source must be file or api"]);
    expect((await runs.POST(post("/api/runs", "{nope"))).status).toBe(400);
    expect(await store.list("queue/")).toEqual([]);
  });

  it("keeps a custom goal (trimmed), drops the preset's own, rejects one over the limit", async () => {
    const res = await runs.POST(post("/api/runs", { ...req, goal: "  Buy a pair of black sneakers in size 42 and check out. " }));
    const { runId } = await res.json();
    const [q] = await Promise.all((await store.list("queue/")).map((k) => store.getJson<QueuedRun>(k)));
    expect(q!.req.goal).toBe("Buy a pair of black sneakers in size 42 and check out.");
    const detail = await (await runDetail.GET(get(`/api/runs/${runId}`), ctx({ id: runId }))).json();
    expect(detail.flow.goal).toBe("Buy a pair of black sneakers in size 42 and check out.");
    expect(detail.flow.required.steps).toContain("Payment");

    const preset = await (await runs.POST(post("/api/runs", { ...req, goal: "Find a blue polo shirt, buy it in size M and check out." }))).json();
    const queued = await Promise.all((await store.list("queue/")).map((k) => store.getJson<QueuedRun>(k)));
    expect(queued.find((x) => x!.runId === preset.runId)!.req).not.toHaveProperty("goal");
    const long = await runs.POST(post("/api/runs", { ...req, goal: "x".repeat(301) }));
    expect(long.status).toBe(400);
    expect((await long.json()).errors).toEqual(["goal must be a string of at most 300 characters"]);
  });

  it("refuses with 429 when today's runs plus the queue reach the cap", async () => {
    await store.putJson("settings.json", { maxRunsPerDay: 2 });
    await store.putJson("usage.json", { date: new Date().toISOString().slice(0, 10), runs: 1 });
    expect((await runs.POST(post("/api/runs", req))).status).toBe(201);
    const res = await runs.POST(post("/api/runs", req));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Run cap reached/);
  });
});

describe("GET /api/control", () => {
  it("splits active and recent runs and reports the orchestrator only while its heartbeat is fresh", async () => {
    await seedRun("a-running", "retesting");
    await seedRun("b-done", "done");
    await seedRun("fixture-live", "collecting");
    await runs.POST(post("/api/runs", req));
    let body = await (await control.GET()).json();
    expect(body.active.map((r: { runId: string }) => r.runId)).toEqual(["a-running"]);
    expect(body.recent.map((r: { runId: string }) => r.runId).sort()).toEqual(["b-done", "fixture-live"]);
    expect(body.queued).toHaveLength(1);
    expect(body.usage).toMatchObject({ runs: 0, max: 10 });
    expect(body.settings.swarmRunner).toBe("offline");
    expect(body.orchestrator).toBeUndefined();

    const now = new Date().toISOString();
    await store.putJson("orchestrator.json", { host: "tenki", sandboxId: "sbx", version: "x", startedAt: now, lastSeenAt: now, activeRunIds: [], queueDepth: 1 });
    body = await (await control.GET()).json();
    expect(body.orchestrator).toMatchObject({ host: "tenki", sandboxId: "sbx" });

    const old = new Date(Date.now() - 21_000).toISOString();
    await store.putJson("orchestrator.json", { host: "tenki", version: "x", startedAt: old, lastSeenAt: old, activeRunIds: [], queueDepth: 0 });
    expect((await (await control.GET()).json()).orchestrator).toBeUndefined();
  });
});

describe("cancel and retry", () => {
  it("cancels a queued run: dequeued and failed right away", async () => {
    const { runId } = await (await runs.POST(post("/api/runs", req))).json();
    const res = await cancel.POST(post(`/api/runs/${runId}/cancel`), ctx({ id: runId }));
    expect(await res.json()).toEqual({ ok: true });
    expect(await store.list("queue/")).toEqual([]);
    expect(await store.getJson(`runs/${runId}/status.json`)).toMatchObject({ phase: "failed", error: "cancelled" });
    expect(await store.getJson(`runs/${runId}/cancel.json`)).toMatchObject({ runId });
  });

  it("asks the orchestrator to cancel a running run; refuses finished and unknown runs", async () => {
    await seedRun("r", "analyzing");
    const res = await cancel.POST(post("/api/runs/r/cancel", { reason: "wrong flow" }), ctx({ id: "r" }));
    expect(res.status).toBe(200);
    expect(await store.getJson("runs/r/cancel.json")).toMatchObject({ runId: "r", reason: "wrong flow" });
    await seedRun("d", "done");
    expect((await cancel.POST(post("/api/runs/d/cancel"), ctx({ id: "d" }))).status).toBe(409);
    expect((await cancel.POST(post("/api/runs/x/cancel"), ctx({ id: "x" }))).status).toBe(404);
    expect((await cancel.POST(post("/api/runs/../cancel"), ctx({ id: ".." }))).status).toBe(404);
  });

  it("retries with the original request (request.json), else rebuilt from config.json", async () => {
    await seedRun("r1", "failed");
    await store.putJson("runs/r1/request.json", req);
    const res = await retry.POST(post("/api/runs/r1/retry"), ctx({ id: "r1" }));
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    const [q] = await Promise.all((await store.list("queue/")).map((k) => store.getJson<QueuedRun>(k)));
    expect(q).toMatchObject({ runId, req });

    await seedRun("r2", "done");
    await store.putJson("runs/r2/fix.json", { attempts: [] });
    await retry.POST(post("/api/runs/r2/retry"), ctx({ id: "r2" }));
    const reqs = await Promise.all((await store.list("queue/")).map((k) => store.getJson<QueuedRun>(k)));
    expect(reqs.map((x) => x!.req)).toContainEqual({ flowId: "buy-tshirt", window: { from: "2026-09-01", to: "2026-09-29" }, source: "file", autoFix: true });
    expect((await retry.POST(post("/api/runs/nope/retry"), ctx({ id: "nope" }))).status).toBe(404);
  });
});

describe("settings", () => {
  it("returns defaults, saves validated updates and rejects bad ones", async () => {
    expect((await (await settings.GET()).json()).swarmSpeed).toBe(1);
    const ok = await settings.PUT(put("/api/settings", { swarmSpeed: 4, swarmRunner: "tenki" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ swarmSpeed: 4, swarmRunner: "tenki", maxRunsPerDay: 10 });
    expect(await store.getJson("settings.json")).toMatchObject({ swarmSpeed: 4 });
    const bad = await settings.PUT(put("/api/settings", { swarmSpeed: -1, nope: true }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors).toHaveLength(2);
    expect((await (await settings.GET()).json()).swarmSpeed).toBe(4);
  });
});

describe("run detail", () => {
  it("lists only pipeline runs and derives a retest's agents from its PostHog snapshot", async () => {
    await seedRun("a1", "done");
    await store.putJson("runs/a1/metrics.json", {
      runId: "a1", flowId: "buy-tshirt", buildSha: "abc", personas: [],
      segments: [{ segmentId: "mobile", n: 40, users: 38, completed: 2, completionRate: 0.05, gaveUp: 38, invalidCompletions: 0, medianSteps: 0, medianTimeMs: 0, funnel: [] }],
    });
    await store.putJson("runs/not-a-run/config.json", { runId: "not-a-run", kind: "analysis", flowId: "buy-tshirt", posthog: { source: "file", buildSha: "" }, personaIds: [], seeds: {}, targetUrl: "x", createdAt: "2026-01-01" });
    await store.putJson("runs/a1-retest1/config.json", {
      runId: "a1-retest1", kind: "retest", flowId: "buy-tshirt", posthog: { source: "file", buildSha: "pre" },
      personaIds: ["kai"], seeds: { kai: [7, 8] }, targetUrl: "https://preview.example", baselineRunId: "a1", createdAt: new Date().toISOString(),
    });
    const ev = (event: string, ts: number, props: Record<string, unknown> = {}) => JSON.stringify({
      uuid: `${ts}`, event, distinct_id: "swarm:kai-7", timestamp: new Date(Date.UTC(2026, 9, 17, 12, 0, ts)).toISOString(),
      properties: { $session_id: "s7", swarm_run: "a1-retest1", swarm_agent: "kai-7", swarm_persona: "kai", $current_url: "https://preview.example/cart", ...props },
    });
    await store.putText("runs/a1-retest1/posthog.jsonl", [
      ev("$pageview", 1), ev("swarm_think_aloud", 2, { note: "Cart looks fine." }), ev("$autocapture", 3),
      ev("swarm_give_up", 4, { reason: "Too many fields.", step: "Cart" }),
    ].join("\n") + "\n");
    await store.putBytes("runs/a1-retest1/screenshots/kai-7.png", new Uint8Array([1]));

    const list = await (await runs.GET()).json();
    // A live retest is shown through its analysis run until it has metrics.
    expect(list.map((r: { runId: string }) => r.runId)).toEqual(["a1"]);
    const a1 = list.find((r: { runId: string }) => r.runId === "a1");
    expect(a1.groups).toEqual([{ kind: "segment", id: "mobile", personaId: "kai", n: 40, completed: 2, provisional: false }]);

    const d = await (await runDetail.GET(get("/api/runs/a1-retest1"), ctx({ id: "a1-retest1" }))).json();
    expect(d.eventsFrom).toBe("snapshot");
    expect(d.agents).toEqual([
      expect.objectContaining({ agentId: "kai-7", state: "gave-up", step: "Cart", actions: 1, lastNote: "Cart looks fine.", outcomeNote: "Too many fields.", latestScreenshot: "screenshots/kai-7.png", sessionId: "s7" }),
      expect.objectContaining({ agentId: "kai-8", state: "running" }),
    ]);
    expect(d.giveUps).toEqual([{ step: "Cart", quotes: [{ agentId: "kai-7", personaId: "kai", note: "Too many fields." }] }]);
    expect(d.provisionalMetrics.personas[0]).toMatchObject({ personaId: "kai", n: 2, completed: 0, gaveUp: 1 });
  });
});

describe("swarm topology and files", () => {
  it("serves swarm.json, 404 before it exists", async () => {
    expect((await swarm.GET(get("/api/runs/r/swarm"), ctx({ id: "r" }))).status).toBe(404);
    await store.putJson("runs/r/swarm.json", { runId: "r", backend: "offline", sandboxes: [], updatedAt: "x" });
    expect(await (await swarm.GET(get("/api/runs/r/swarm"), ctx({ id: "r" }))).json()).toMatchObject({ backend: "offline" });
  });

  it("serves screenshots from the store with caching headers and refuses traversal", async () => {
    await store.putBytes("runs/r/screenshots/kai-1.png", new Uint8Array([137, 80, 78, 71]));
    const res = await files.GET(get("/x?v=3"), ctx({ id: "r", path: ["screenshots", "kai-1.png"] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    // Unversioned URLs of a screenshot that is rewritten as the agent moves are revalidated.
    expect((await files.GET(get("/x"), ctx({ id: "r", path: ["screenshots", "kai-1.png"] }))).headers.get("cache-control")).toBe("private, no-cache");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    const miss = await files.GET(get("/x"), ctx({ id: "r", path: ["screenshots", "missing.png"] }));
    expect(miss.status).toBe(404);
    expect(miss.headers.get("cache-control")).toBe("no-store");
    for (const path of [["..", "x.png"], ["screenshots/../../x.png"], ["config.json"]])
      expect((await files.GET(get("/x"), ctx({ id: "r", path }))).status).toBe(404);
  });
});

const couponFlow = {
  id: "coupon", goal: "Buy a t-shirt with a coupon", startUrl: "https://example.com/",
  success: { urlPattern: "/thanks" },
  steps: [{ route: "/", name: "Home" }, { route: "/cart", name: "Cart" }],
  required: { steps: ["Cart"], fields: ["email"] },
};

describe("flows", () => {
  it("validates, saves and reads back a new flow; a stale draftHash is refused", async () => {
    const v = await (await flowValidate.POST(post("/api/flows/validate", { flow: couponFlow }))).json();
    expect(v).toMatchObject({ ok: true, isNew: true, flow: { id: "coupon" } });
    expect(v.changes.length).toBeGreaterThan(0);

    const stale = await flowRoute.PUT(put("/api/flows/coupon", { flow: couponFlow, draftHash: "stale" }), ctx({ id: "coupon" }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("Flow changed since it was reviewed");
    expect((await flowRoute.GET(get("/api/flows/coupon"), ctx({ id: "coupon" }))).status).toBe(404);

    const saved = await flowRoute.PUT(put("/api/flows/coupon", { flow: couponFlow, draftHash: v.draftHash }), ctx({ id: "coupon" }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).flow.id).toBe("coupon");
    expect(await (await flowRoute.GET(get("/api/flows/coupon"), ctx({ id: "coupon" }))).json()).toEqual(v.flow);
    expect((await (await flowsRoute.GET()).json()).map((f: { id: string }) => f.id)).toContain("coupon");
    expect((await (await flowValidate.POST(post("/api/flows/validate", { flow: couponFlow }))).json()).isNew).toBe(false);
  });

  it("reports missing fields, and refuses a mismatched or invalid PUT", async () => {
    const bad = await (await flowValidate.POST(post("/api/flows/validate", { flow: { id: "x" } }))).json();
    expect(bad).toMatchObject({ ok: false, missing: expect.arrayContaining(["goal"]) });
    const v = await (await flowValidate.POST(post("/api/flows/validate", { flow: couponFlow }))).json();
    expect((await flowRoute.PUT(put("/api/flows/other", { flow: couponFlow, draftHash: v.draftHash }), ctx({ id: "other" }))).status).toBe(400);
    expect((await flowRoute.PUT(put("/api/flows/coupon", { flow: { id: "coupon" }, draftHash: "x" }), ctx({ id: "coupon" }))).status).toBe(400);
  });

  it("lets POST /api/runs start a stored flow and rejects unknown ones", async () => {
    expect((await runs.POST(post("/api/runs", { ...req, flowId: "coupon" }))).status).toBe(400);
    await store.putJson("flows/coupon.json", couponFlow);
    expect((await runs.POST(post("/api/runs", { ...req, flowId: "coupon" }))).status).toBe(201);
  });
});

describe("GET /api/personas", () => {
  it("lists the personas with their segment", async () => {
    const list = await (await personasRoute.GET()).json();
    expect(list).toContainEqual(expect.objectContaining({ id: "kai", segmentId: "mobile", control: false }));
    expect(list.find((p: { id: string }) => p.id === "typical")).toMatchObject({ segmentId: "desktop", control: true });
  });
});

const finding = (id: string, severity: string, sessions: number) => ({ id, severity, segments: ["mobile"], personas: ["kai"], step: "Cart", page: "/cart", title: id, evidence: { sessions, users: sessions } });

describe("POST /api/runs/:id/fix", () => {
  it("writes fix-request.json once for a done analysis and validates finding ids", async () => {
    await seedRun("a", "done");
    await store.putJson("runs/a/findings.json", [finding("f1", "low", 5), finding("f2", "high", 3)]);
    expect((await fix.POST(post("/api/runs/a/fix", { findingIds: ["zzz"] }), ctx({ id: "a" }))).status).toBe(400);
    expect((await fix.POST(post("/api/runs/a/fix", { findingIds: [] }), ctx({ id: "a" }))).status).toBe(400);
    const res = await fix.POST(post("/api/runs/a/fix", { findingIds: ["f1"] }), ctx({ id: "a" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, findingIds: ["f1"] });
    expect(await store.getJson("runs/a/fix-request.json")).toMatchObject({ runId: "a", findingIds: ["f1"] });
    expect((await fix.POST(post("/api/runs/a/fix", { findingIds: ["f1"] }), ctx({ id: "a" }))).status).toBe(409);
  });

  it("serializes concurrent requests: exactly one wins", async () => {
    await seedRun("p", "done");
    await store.putJson("runs/p/findings.json", [finding("f1", "low", 1), finding("f2", "low", 2)]);
    const codes = (await Promise.all([
      fix.POST(post("/api/runs/p/fix", { findingIds: ["f1"] }), ctx({ id: "p" })),
      fix.POST(post("/api/runs/p/fix", { findingIds: ["f2"] }), ctx({ id: "p" })),
    ])).map((r) => r.status);
    expect(codes.sort()).toEqual([202, 409]);
  });

  it("defaults to the top findings by severity then sessions", async () => {
    await seedRun("b", "done");
    await store.putJson("runs/b/findings.json", [finding("f1", "low", 9), finding("f2", "high", 3), finding("f3", "high", 7), finding("f4", "medium", 1)]);
    const res = await fix.POST(post("/api/runs/b/fix"), ctx({ id: "b" }));
    expect((await res.json()).findingIds).toEqual(["f3", "f2", "f4"]);
  });

  it("refuses unknown, unfinished, already-fixed and retest runs", async () => {
    expect((await fix.POST(post("/api/runs/nope/fix"), ctx({ id: "nope" }))).status).toBe(404);
    await seedRun("c", "analyzing");
    expect((await fix.POST(post("/api/runs/c/fix"), ctx({ id: "c" }))).status).toBe(409);
    await seedRun("d", "done");
    await store.putJson("runs/d/findings.json", [finding("f1", "low", 1)]);
    await store.putJson("runs/d/fix.json", { baselineRunId: "d", repo: "x", attempts: [] });
    expect((await fix.POST(post("/api/runs/d/fix"), ctx({ id: "d" }))).status).toBe(409);
    await seedRun("e", "done", { kind: "retest" });
    expect((await fix.POST(post("/api/runs/e/fix"), ctx({ id: "e" }))).status).toBe(409);
  });
});

describe("POST /api/runs/:id/decision", () => {
  const seedFix = async (runId: string, phase: RunStatus["phase"], attemptStatus: string) => {
    await seedRun(runId, phase);
    await store.putJson(`runs/${runId}/fix.json`, { baselineRunId: runId, repo: "x", attempts: [{ attempt: 1, findingIds: ["f1"], status: attemptStatus }] });
  };

  it("needs an override to accept a not-proven fix, and only one decision at a time", async () => {
    await seedFix("a", "awaiting-decision", "not-proven");
    const refused = await decision.POST(post("/api/runs/a/decision", { decision: "accept" }), ctx({ id: "a" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("Fix not proven: pass override to accept anyway");
    expect(await store.getJson("runs/a/decision.json")).toBeUndefined();
    const ok = await decision.POST(post("/api/runs/a/decision", { decision: "accept", override: true, reason: "ship it" }), ctx({ id: "a" }));
    expect(ok.status).toBe(202);
    expect(await store.getJson("runs/a/decision.json")).toMatchObject({ runId: "a", decision: "accept", override: true, reason: "ship it" });
    const again = await decision.POST(post("/api/runs/a/decision", { decision: "reject" }), ctx({ id: "a" }));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("A decision is already pending");
  });

  it("serializes concurrent decisions: exactly one wins", async () => {
    await seedFix("q", "awaiting-decision", "ready");
    const codes = (await Promise.all([
      decision.POST(post("/api/runs/q/decision", { decision: "accept" }), ctx({ id: "q" })),
      decision.POST(post("/api/runs/q/decision", { decision: "reject" }), ctx({ id: "q" })),
    ])).map((r) => r.status);
    expect(codes.sort()).toEqual([202, 409]);
  });

  it("rejects without an override, and refuses wrong phases, wrong attempts and bad bodies", async () => {
    await seedFix("b", "awaiting-decision", "not-proven");
    expect((await decision.POST(post("/api/runs/b/decision", { decision: "reject" }), ctx({ id: "b" }))).status).toBe(202);
    await seedFix("c", "done", "ready");
    expect((await decision.POST(post("/api/runs/c/decision", { decision: "accept" }), ctx({ id: "c" }))).status).toBe(409);
    await seedFix("d", "awaiting-decision", "merged");
    const none = await decision.POST(post("/api/runs/d/decision", { decision: "accept" }), ctx({ id: "d" }));
    expect(none.status).toBe(409);
    expect((await none.json()).error).toBe("No fix awaiting a decision");
    await seedFix("e", "awaiting-decision", "ready");
    expect((await decision.POST(post("/api/runs/e/decision", { decision: "maybe" }), ctx({ id: "e" }))).status).toBe(400);
    expect((await decision.POST(post("/api/runs/e/decision", { decision: "accept" }), ctx({ id: "e" }))).status).toBe(202);
    expect((await decision.POST(post("/api/runs/nope/decision", { decision: "accept" }), ctx({ id: "nope" }))).status).toBe(404);
  });
});

describe("fix/pr.diff", () => {
  it("is served as text/x-diff; other non-images stay refused", async () => {
    await store.putBytes("runs/r/fix/pr.diff", new TextEncoder().encode("diff --git a b"));
    const res = await files.GET(get("/x"), ctx({ id: "r", path: ["fix", "pr.diff"] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-diff");
    expect(await res.text()).toBe("diff --git a b");
    expect((await files.GET(get("/x"), ctx({ id: "r", path: ["fix", "other.diff"] }))).status).toBe(404);
  });
});
