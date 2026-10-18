// The FrictionSwarm MCP tools: each validates its input, calls the dashboard
// API and replies with markdown for the conversation plus the JSON behind it.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Flow, RunPhase } from "@frictionswarm/shared";
import type { ControlOverview, SwarmTopology } from "../../dashboard/lib/control-types";
import type { RunDetail } from "../../dashboard/lib/types";
import { ApiError, type ApiClient } from "./client";
import { analysisReport, decisionPackage, flowCard, flowLink, isRehearsal, runLink, story, type Links } from "./format";

/** Same threshold as HEARTBEAT_STALE_MS in @frictionswarm/store (not imported: this server only speaks HTTP). */
const HEARTBEAT_STALE_MS = 20_000;

export type ToolOptions = {
  /** analyze_flow polls the run this often (default 2 s)… */
  pollMs?: number;
  /** …for at most this long (default 60 s) before handing over to get_run. */
  timeoutMs?: number;
};

type Reply = { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };

const reply = (text: string, structuredContent: Record<string, unknown>, isError = false): Reply => ({
  content: [{ type: "text", text }],
  structuredContent,
  ...(isError ? { isError: true } : {}),
});

const errorReply = (err: ApiError): Reply =>
  reply([err.message, ...err.details.map((d) => `- ${d}`)].join("\n"), { error: err.message, status: err.status, details: err.details }, true);

/** API failures become readable tool errors, never stacks. */
const guarded =
  <A>(fn: (args: A) => Promise<Reply>) =>
  async (args: A): Promise<Reply> => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof ApiError) return errorReply(err);
      throw err;
    }
  };

const FINISHED: RunPhase[] = ["done", "failed"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seg = encodeURIComponent;

const stepSchema = z.object({ route: z.string().describe("Pathname pattern, `*` wildcard, optional ?key=value"), name: z.string() });
const flowShape = {
  id: z.string().describe("Lowercase slug, e.g. buy-tshirt"),
  goal: z.string().describe("What the user is trying to do, in one sentence"),
  startUrl: z.string().describe("http(s) URL where the flow starts"),
  success: z.object({ urlPattern: z.string().optional(), visibleText: z.string().optional() }).describe("At least one of urlPattern / visibleText"),
  steps: z.array(stepSchema).describe("Funnel steps in order: route → step name"),
  required: z
    .object({ steps: z.array(z.string()), fields: z.array(z.string()) })
    .describe("Step names the coding agent may not remove, and required form fields (email, fullName, address, city, postalCode, country, cardNumber)"),
};
const fullFlow = z.object(flowShape);
/** draft_flow takes whatever the user has said so far; the dashboard reports what is missing. */
const partialFlow = z
  .object({ ...flowShape, required: z.object({ steps: z.array(z.string()).optional(), fields: z.array(z.string()).optional() }) })
  .partial();
const runId = z.string().describe("Run id, e.g. 2026-10-18T13-01-16-2f84");

export function registerTools(server: McpServer, api: ApiClient, links: Links, opts: ToolOptions = {}): void {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  /** The warning to lead with when the orchestrator (daemon) is not running; undefined when it is, or when we can't tell. */
  async function orchestratorWarning(): Promise<string | undefined> {
    const control = await api.get<ControlOverview>("/api/control").catch(() => undefined);
    if (!control) return undefined;
    const hb = control.orchestrator;
    if (hb && Date.now() - Date.parse(hb.lastSeenAt) <= HEARTBEAT_STALE_MS) return undefined;
    return "⚠ Orchestrator offline: requests are stored, but nothing runs until the orchestrator is back (`npm run orchestrator`, or the dashboard in inline mode).";
  }
  const withWarning = (warning: string | undefined, text: string) => (warning ? `${warning}\n\n${text}` : text);

  const getRun = (id: string) => api.get<RunDetail>(`/api/runs/${seg(id)}`);

  server.registerTool(
    "list_flows",
    { title: "List flows", description: "Lists the user flows FrictionSwarm can analyze (id, goal, start URL, step count), with dashboard links." },
    guarded(async () => {
      const flows = await api.get<Flow[]>("/api/flows");
      const lines = flows.map((f) => `- **${f.id}**: ${f.goal} · ${f.startUrl} · ${f.steps.length} steps · ${flowLink(links, f.id)}`);
      return reply(lines.length ? lines.join("\n") : "No flows yet: draft one with draft_flow.", { flows });
    }),
  );

  server.registerTool(
    "get_flow",
    { title: "Show a flow", description: "Shows one flow as a review card: goal, start URL, success rule, required fields, numbered steps (🔒 = required).", inputSchema: { flowId: z.string() } },
    guarded(async ({ flowId }: { flowId: string }) => {
      const flow = await api.get<Flow>(`/api/flows/${seg(flowId)}`);
      return reply(`${flowCard(flow)}\n\nDashboard: ${flowLink(links, flow.id)}`, { flow });
    }),
  );

  server.registerTool(
    "draft_flow",
    {
      title: "Draft a flow",
      description:
        "Validates a full or partial flow without saving it. If fields are missing or invalid, it lists them: ask the user only for those, then call again. " +
        "When complete it returns a review card and a draftHash: show the card to the user verbatim and ask them to approve it before calling save_flow. " +
        "Pass baseFlowId to show the changes against an existing flow.",
      inputSchema: { flow: partialFlow, baseFlowId: z.string().optional() },
    },
    guarded(async ({ flow, baseFlowId }: { flow: z.infer<typeof partialFlow>; baseFlowId?: string }) => {
      type Validation = { ok: true; flow: Flow; draftHash: string; changes: string[]; isNew: boolean } | { ok: false; missing: string[]; errors: string[] };
      const v = await api.post<Validation>("/api/flows/validate", { flow, ...(baseFlowId ? { baseFlowId } : {}) });
      if (!v.ok) {
        const lines = ["This flow isn't complete yet."];
        if (v.missing.length) lines.push("", "Still needed (ask the user):", ...v.missing.map((m) => `- ${m}`));
        if (v.errors.length) lines.push("", "To fix:", ...v.errors.map((e) => `- ${e}`));
        return reply(lines.join("\n"), v);
      }
      const text = [
        v.isNew ? "**New flow** for review:" : "**Edited flow** for review:",
        "",
        flowCard(v.flow, v.isNew ? undefined : v.changes),
        "",
        `draftHash: \`${v.draftHash}\``,
        `Dashboard (${v.isNew ? "once saved" : "saved version"}): ${flowLink(links, v.flow.id)}`,
        "",
        "Show this card to the user. Call save_flow with this exact flow and draftHash only after they say yes.",
      ].join("\n");
      return reply(text, v);
    }),
  );

  server.registerTool(
    "save_flow",
    {
      title: "Save a reviewed flow",
      description:
        "Saves a flow. Only after the user has seen its review card from draft_flow in this conversation and explicitly approved it. " +
        "Pass the same flow and the draftHash draft_flow returned; the dashboard refuses it if anything changed since that card.",
      inputSchema: { flow: fullFlow, draftHash: z.string() },
    },
    guarded(async ({ flow, draftHash }: { flow: z.infer<typeof fullFlow>; draftHash: string }) => {
      const saved = await api.put<{ flow: Flow }>(`/api/flows/${seg(flow.id)}`, { flow, draftHash });
      return reply(`Saved flow **${saved.flow.id}**: ${flowLink(links, saved.flow.id)}\nAnalyze it with analyze_flow.`, saved);
    }),
  );

  server.registerTool(
    "list_personas",
    { title: "List personas", description: "Lists the persona agents used on re-tests, and the real-user segment each one stands in for." },
    guarded(async () => {
      type PersonaView = { id: string; name: string; oneLiner: string; segmentId?: string; control: boolean };
      const personas = await api.get<PersonaView[]>("/api/personas");
      const lines = personas.map(
        (p) => `- **${p.id}** (${p.name})${p.control ? " · control" : ""}${p.segmentId ? ` · stands in for segment \`${p.segmentId}\`` : ""}: ${p.oneLiner}`,
      );
      return reply(lines.join("\n"), { personas });
    }),
  );

  server.registerTool(
    "analyze_flow",
    {
      title: "Analyze a flow",
      description:
        "Analyzes a flow against real PostHog users: per-segment funnels (conversion, drop-off, N), releases and top findings with replay links. " +
        "Never starts a fix. Waits up to about a minute; if the run is still going it returns the runId: follow with get_run. " +
        "window defaults to the current production release, last 28 days.",
      inputSchema: {
        flowId: z.string(),
        window: z.object({ from: z.string().describe("YYYY-MM-DD"), to: z.string().describe("YYYY-MM-DD, exclusive") }).optional(),
        source: z.enum(["file", "api"]).optional().describe("file = the offline dataset, api = live PostHog"),
      },
    },
    guarded(async ({ flowId, window, source }: { flowId: string; window?: { from: string; to: string }; source?: "file" | "api" }) => {
      const warning = await orchestratorWarning();
      const { runId: id } = await api.post<{ runId: string }>("/api/runs", { flowId, ...(window ? { window } : {}), ...(source ? { source } : {}), autoFix: false });
      const pending = (phase: string) =>
        reply(withWarning(warning, `Analysis \`${id}\` is ${phase}. Follow with get_run.\nRun: ${runLink(links, id)}`), { runId: id, phase });
      if (warning) return pending("queued");

      const deadline = Date.now() + timeoutMs;
      let run = await getRun(id);
      while (!FINISHED.includes(run.status.phase) && Date.now() < deadline) {
        await sleep(pollMs);
        run = await getRun(id);
      }
      if (run.status.phase === "failed")
        return reply(`Analysis \`${id}\` failed: ${run.status.error ?? run.status.message ?? "no error given"}\nRun: ${runLink(links, id)}`, { runId: id, phase: "failed" }, true);
      if (run.status.phase !== "done") return pending(run.status.phase);
      const text = `${analysisReport(run, links)}\n\nTo fix findings: start_fix with runId \`${id}\` and the findingIds the user picks (default: the top ones).`;
      return reply(text, { runId: id, phase: "done", metrics: run.metrics, findings: run.findings });
    }),
  );

  server.registerTool(
    "start_fix",
    {
      title: "Fix findings",
      description:
        "Fixes findings of a finished analysis: a coding agent opens a draft PR, the deploy preview is re-tested by persona agents, and the run waits for the user's decision. " +
        "findingIds defaults to the top 1–3 findings. Follow with get_run.",
      inputSchema: {
        runId,
        findingIds: z.array(z.string()).optional().describe("Finding ids from analyze_flow, e.g. [\"F1\", \"F2\"]"),
        seedsPerPersona: z.number().int().optional().describe("Re-test agents per persona"),
      },
    },
    guarded(async ({ runId: id, findingIds, seedsPerPersona }: { runId: string; findingIds?: string[]; seedsPerPersona?: number }) => {
      const warning = await orchestratorWarning();
      const ack = await api.post<{ ok: true; findingIds: string[] }>(`/api/runs/${seg(id)}/fix`, {
        ...(findingIds ? { findingIds } : {}),
        ...(seedsPerPersona !== undefined ? { seedsPerPersona } : {}),
      });
      const text = [
        `Fix requested for ${ack.findingIds.join(", ")} on run \`${id}\`.`,
        "Next: the coding agent opens a draft PR, the deploy preview goes live, persona agents re-test it, then the run waits for your decision.",
        "Follow with get_run every 20–30 s.",
        `Run: ${runLink(links, id)}`,
      ].join("\n");
      return reply(withWarning(warning, text), { runId: id, findingIds: ack.findingIds });
    }),
  );

  server.registerTool(
    "get_run",
    {
      title: "Follow a run",
      description:
        "Shows a run's phase and its story so far (analysis, fix, PR, preview, re-test, verdict, decision). " +
        "To follow a run, call it every 20–30 s and post only the lines that are new. When it reaches awaiting-decision, call get_decision.",
      inputSchema: { runId },
    },
    guarded(async ({ runId: id }: { runId: string }) => {
      const run = await getRun(id);
      const { status } = run;
      const attempt = run.fix?.attempts.at(-1);
      const retestId = status.retestRunId ?? attempt?.retestRunId;
      const swarm = status.phase === "retesting" && retestId ? await api.get<SwarmTopology>(`/api/runs/${seg(retestId)}/swarm`).catch(() => undefined) : undefined;
      const lines = story(run, swarm);
      const warning = FINISHED.includes(status.phase) ? undefined : await orchestratorWarning();

      const text = [`**${id}** · ${status.phase}${status.message ? ` · ${status.message}` : ""}`];
      if (status.error) text.push(`Error: ${status.error}`);
      text.push("", ...lines, "");
      if (status.phase === "awaiting-decision") text.push("The fix is waiting for the user's decision: call get_decision.");
      if (status.phase === "done" && attempt?.decision?.decision === "accept")
        text.push(isRehearsal(attempt) ? "Accepted (rehearsal — no PR merged)." : `Merged${attempt.decision.mergeSha ? ` as ${attempt.decision.mergeSha.slice(0, 7)}` : ""}: production redeploys from main.`);
      text.push(`Run: ${runLink(links, id)}`);
      if (attempt?.prUrl && !isRehearsal(attempt)) text.push(`PR: ${attempt.prUrl}`);
      return reply(withWarning(warning, text.join("\n")), {
        runId: id,
        phase: status.phase,
        message: status.message,
        error: status.error,
        story: lines,
        attempt,
        link: runLink(links, id),
      });
    }),
  );

  server.registerTool(
    "get_decision",
    {
      title: "Decision package",
      description:
        "The decision package for a fix awaiting the user's decision: verdict, before/after per segment ↔ persona, per-step conversion, findings addressed, the change and its diff, links. " +
        "Show it to the user in full, then ask whether to accept (merge) or reject (close the PR).",
      inputSchema: { runId },
    },
    guarded(async ({ runId: id }: { runId: string }) => {
      const run = await getRun(id);
      const attempt = run.fix?.attempts.at(-1);
      const decided = run.status.phase === "done" && !!attempt?.decision;
      if (run.status.phase !== "awaiting-decision" && !decided)
        return reply(
          `Run \`${id}\` is ${run.status.phase}: there is no fix waiting for a decision yet. Follow with get_run until it reaches awaiting-decision.\nRun: ${runLink(links, id)}`,
          { runId: id, phase: run.status.phase },
          true,
        );
      const diff = await api.getText(`/api/runs/${seg(id)}/files/fix/pr.diff`);
      return reply(decisionPackage(run, diff, links), { runId: id, phase: run.status.phase, attempt, findingIds: attempt?.findingIds ?? [] });
    }),
  );

  server.registerTool(
    "accept_fix",
    {
      title: "Accept a fix",
      description:
        "Accepts the fix: the orchestrator merges its PR into production main. Only after the user has seen the decision package from get_decision in this conversation and explicitly said yes. " +
        "Set override only when the verdict is not proven and the user explicitly chose to accept anyway. Follow with get_run until it shows merged.",
      inputSchema: { runId, override: z.boolean().optional().describe("Accept a not-proven fix anyway") },
    },
    guarded(async ({ runId: id, override }: { runId: string; override?: boolean }) => {
      const warning = await orchestratorWarning();
      await api.post(`/api/runs/${seg(id)}/decision`, { decision: "accept", ...(override ? { override: true } : {}) });
      const text = `Merge requested for run \`${id}\`. The orchestrator merges the PR on its next poll; follow with get_run until it shows merged.\nRun: ${runLink(links, id)}`;
      return reply(withWarning(warning, text), { runId: id, decision: "accept", ...(override ? { override: true } : {}) });
    }),
  );

  server.registerTool(
    "reject_fix",
    {
      title: "Reject a fix",
      description: "Rejects the fix: the orchestrator closes its PR. Ask the user for a short reason. Follow with get_run until it shows rejected.",
      inputSchema: { runId, reason: z.string().optional() },
    },
    guarded(async ({ runId: id, reason }: { runId: string; reason?: string }) => {
      const warning = await orchestratorWarning();
      await api.post(`/api/runs/${seg(id)}/decision`, { decision: "reject", ...(reason ? { reason } : {}) });
      const text = `Close requested for run \`${id}\`. The orchestrator closes the PR on its next poll; follow with get_run until it shows rejected.\nRun: ${runLink(links, id)}`;
      return reply(withWarning(warning, text), { runId: id, decision: "reject", ...(reason ? { reason } : {}) });
    }),
  );

  server.registerTool(
    "cancel_run",
    { title: "Cancel a run", description: "Cancels a queued or running run.", inputSchema: { runId } },
    guarded(async ({ runId: id }: { runId: string }) => {
      const warning = await orchestratorWarning();
      await api.post(`/api/runs/${seg(id)}/cancel`);
      return reply(withWarning(warning, `Cancel requested for run \`${id}\`.\nRun: ${runLink(links, id)}`), { runId: id, cancelled: true });
    }),
  );
}
