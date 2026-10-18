import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buyTshirt, type FixAttempt, type RunPhase } from "@frictionswarm/shared";
import type { RunDetail } from "../../dashboard/lib/types";
import { ApiClient } from "./client";
import { registerTools } from "./tools";

const BASE = "http://localhost:3000";
const links = { dashboard: (p: string) => `${BASE}${p}` };

type Reply = { status?: number; body?: unknown; text?: string };
type Call = { method: string; path: string; body?: unknown; auth?: string | null };

/** A fake dashboard: "METHOD /path" → reply (or a function of the request body). */
function fakeDashboard(routes: Record<string, Reply | ((body: unknown) => Reply)>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return Response.json({ error: "Not found" }, { status: 404 });
    const r = typeof route === "function" ? route(body) : route;
    if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200, headers: { "content-type": "text/x-diff" } });
    return Response.json(r.body ?? {}, { status: r.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(routes: Parameters<typeof fakeDashboard>[0]) {
  const dash = fakeDashboard(routes);
  const server = new McpServer({ name: "frictionswarm", version: "0.0.0" });
  registerTools(server, new ApiClient({ baseUrl: BASE, token: "tok", fetch: dash.fetch }), links, { pollMs: 1, timeoutMs: 20 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown };
    return { ...res, text: res.content.map((c) => c.text).join("\n") };
  };
  return { client, call, calls: dash.calls };
}

const online = { body: { orchestrator: { lastSeenAt: new Date().toISOString() } } };
const offline = { body: { orchestrator: { lastSeenAt: new Date(Date.now() - 60_000).toISOString() } } };

const attempt = (over: Partial<FixAttempt> = {}): FixAttempt => ({
  attempt: 1,
  findingIds: ["F1"],
  status: "ready",
  commitSha: "abc1234ff",
  prNumber: 12,
  prUrl: "https://github.com/FrissA/demo-ecommerce/pull/12",
  previewUrl: "https://deploy-preview-12--swarm-ecommerce.netlify.app",
  retestRunId: "run-1-retest1",
  verdict: { improved: true, targetedPersonas: ["kai"], comparisons: [], reasons: [] },
  ...over,
});

const run = (phase: RunPhase, over: Partial<RunDetail> = {}): RunDetail => ({
  runId: "run-1",
  config: {
    runId: "run-1",
    kind: "analysis",
    flowId: "buy-tshirt",
    posthog: { source: "file", buildSha: "f0a2c4e6" },
    personaIds: [],
    seeds: {},
    targetUrl: "https://swarm-ecommerce.netlify.app",
    createdAt: "2026-10-17T21:00:00.000Z",
  },
  status: { runId: "run-1", phase, updatedAt: "2026-10-17T21:01:00.000Z", history: [{ phase: "analyzing", at: "2026-10-17T21:00:00.000Z" }, { phase, at: "2026-10-17T21:01:00.000Z" }] },
  flow: buyTshirt,
  agents: [],
  giveUps: [],
  metrics: { runId: "run-1", flowId: "buy-tshirt", buildSha: "f0a2c4e6", segments: [], personas: [] },
  findings: [],
  ...over,
});

const draftOk = { ok: true, flow: buyTshirt, draftHash: "hash-1", changes: [], isNew: false };

describe("tools", () => {
  it("registers exactly the spec's tools, and guards the two that act for the user", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["accept_fix", "analyze_flow", "cancel_run", "draft_flow", "get_decision", "get_flow", "get_run", "list_flows", "list_personas", "reject_fix", "save_flow", "start_fix"].sort(),
    );
    for (const name of ["save_flow", "accept_fix"]) expect(tools.find((t) => t.name === name)?.description).toContain("Only after the user has seen");
  });

  it("sends the bearer token", async () => {
    const { call, calls } = await connect({ "GET /api/flows": { body: [buyTshirt] } });
    await call("list_flows");
    expect(calls[0].auth).toBe("Bearer tok");
  });

  it("draft_flow with only a goal lists what is missing and no draftHash", async () => {
    const { call } = await connect({ "POST /api/flows/validate": { body: { ok: false, missing: ["id", "startUrl", "success", "steps", "required"], errors: [] } } });
    const res = await call("draft_flow", { flow: { goal: "Buy socks" } });
    expect(res.isError).toBeFalsy();
    for (const m of ["id", "startUrl", "success", "steps", "required"]) expect(res.text).toContain(m);
    expect(res.text).not.toContain("draftHash");
  });

  it("draft_flow with a full flow shows the review card and its draftHash", async () => {
    const { call } = await connect({ "POST /api/flows/validate": { body: draftOk } });
    const res = await call("draft_flow", { flow: buyTshirt });
    expect(res.text).toContain("1. / → Home");
    expect(res.text).toContain("hash-1");
  });

  it("save_flow sends the draftHash it was given, and reports a changed flow", async () => {
    const ok = await connect({ "PUT /api/flows/buy-tshirt": { body: { flow: buyTshirt } } });
    const res = await ok.call("save_flow", { flow: buyTshirt, draftHash: "hash-1" });
    expect(ok.calls[0].body).toMatchObject({ draftHash: "hash-1", flow: { id: "buy-tshirt" } });
    expect(res.text).toContain(`${BASE}/flows/buy-tshirt`);

    const stale = await connect({ "PUT /api/flows/buy-tshirt": { status: 409, body: { error: "Flow changed since it was reviewed" } } });
    const err = await stale.call("save_flow", { flow: buyTshirt, draftHash: "old" });
    expect(err.isError).toBe(true);
    expect(err.text).toContain("Flow changed since it was reviewed");
  });

  it("accept_fix on a not-proven fix without override is refused", async () => {
    const { call, calls } = await connect({
      "GET /api/control": online,
      "POST /api/runs/run-1/decision": { status: 409, body: { error: "Fix not proven: pass override to accept anyway" } },
    });
    const res = await call("accept_fix", { runId: "run-1" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Fix not proven: pass override to accept anyway");
    expect(calls.find((c) => c.path.endsWith("/decision"))?.body).toEqual({ decision: "accept" });
  });

  it("get_run warns first when the orchestrator heartbeat is stale", async () => {
    const { call } = await connect({ "GET /api/control": offline, "GET /api/runs/run-1": { body: run("fixing") } });
    const res = await call("get_run", { runId: "run-1" });
    expect(res.text.startsWith("⚠ Orchestrator offline")).toBe(true);
  });

  it("cancel_run warns first when the orchestrator heartbeat is stale", async () => {
    const { call } = await connect({ "GET /api/control": offline, "POST /api/runs/run-1/cancel": { body: { ok: true } } });
    const res = await call("cancel_run", { runId: "run-1" });
    expect(res.text.startsWith("⚠ Orchestrator offline")).toBe(true);
    expect(res.text).toContain("Cancel requested");
  });

  it("get_decision refuses before the run awaits a decision", async () => {
    const { call } = await connect({ "GET /api/runs/run-1": { body: run("retesting") } });
    const res = await call("get_decision", { runId: "run-1" });
    expect(res.isError).toBe(true);
  });

  it("analyze_flow queues without autoFix and hands over to get_run when the run is slow", async () => {
    const { call, calls } = await connect({
      "GET /api/control": online,
      "POST /api/runs": { status: 201, body: { runId: "run-1" } },
      "GET /api/runs/run-1": { body: run("analyzing", { metrics: undefined }) },
    });
    const res = await call("analyze_flow", { flowId: "buy-tshirt" });
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ flowId: "buy-tshirt", autoFix: false });
    expect(res.text).toContain("get_run");
  });

  it("start_fix passes the chosen findings", async () => {
    const { call, calls } = await connect({ "GET /api/control": online, "POST /api/runs/run-1/fix": { status: 202, body: { ok: true, findingIds: ["F2"] } } });
    const res = await call("start_fix", { runId: "run-1", findingIds: ["F2"] });
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ findingIds: ["F2"] });
    expect(res.text).toContain("F2");
  });

  it("every successful reply links to the dashboard", async () => {
    const awaiting = run("awaiting-decision", { fix: { baselineRunId: "run-1", repo: "r", attempts: [attempt()] } });
    const { call } = await connect({
      "GET /api/control": online,
      "GET /api/flows": { body: [buyTshirt] },
      "GET /api/flows/buy-tshirt": { body: buyTshirt },
      "POST /api/flows/validate": { body: draftOk },
      "PUT /api/flows/buy-tshirt": { body: { flow: buyTshirt } },
      "POST /api/runs": { status: 201, body: { runId: "run-1" } },
      "GET /api/runs/run-1": { body: awaiting },
      "GET /api/runs/run-1/files/fix/pr.diff": { text: "diff --git a/x b/x\n+y" },
      "POST /api/runs/run-1/fix": { status: 202, body: { ok: true, findingIds: ["F1"] } },
      "POST /api/runs/run-1/decision": { status: 202, body: { ok: true } },
      "POST /api/runs/run-1/cancel": { body: { ok: true } },
    });
    const replies = await Promise.all([
      call("list_flows"),
      call("get_flow", { flowId: "buy-tshirt" }),
      call("draft_flow", { flow: buyTshirt }),
      call("save_flow", { flow: buyTshirt, draftHash: "hash-1" }),
      call("analyze_flow", { flowId: "buy-tshirt" }),
      call("start_fix", { runId: "run-1" }),
      call("get_run", { runId: "run-1" }),
      call("get_decision", { runId: "run-1" }),
      call("accept_fix", { runId: "run-1" }),
      call("reject_fix", { runId: "run-1", reason: "not now" }),
      call("cancel_run", { runId: "run-1" }),
    ]);
    for (const r of replies) {
      expect(r.isError).toBeFalsy();
      expect(r.text).toMatch(/http:\/\/localhost:3000\/(runs|flows)\//);
      expect(r.structuredContent).toBeTypeOf("object");
    }
  });

  it("says so plainly when the dashboard is unreachable", async () => {
    const server = new McpServer({ name: "frictionswarm", version: "0.0.0" });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    registerTools(server, new ApiClient({ baseUrl: BASE, fetch: down }), links);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    const res = (await client.callTool({ name: "list_flows", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Can't reach the dashboard at ${BASE}`);
  });
});
