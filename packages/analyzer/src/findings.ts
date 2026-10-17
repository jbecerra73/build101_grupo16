import { z } from "zod";
import { PERSONAS, type Finding, type Flow, type Metrics, type Persona } from "@frictionswarm/shared";
import { heuristicFindings } from "./heuristic";
import type { RunData } from "./run";
import { frictionSignals, type FrictionSignal } from "./signals";

export const FINDINGS_MODEL = "claude-sonnet-5-5";

export const FindingsSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["high", "medium", "low"]),
      personas: z.array(z.string()),
      step: z.string(),
      page: z.string(),
      selector: z.string().nullable(),
      title: z.string(),
      evidence: z.object({ screenshots: z.array(z.string()), quotes: z.array(z.string()), agentCount: z.number() }),
      suggestedFix: z.string(),
    }),
  ),
});
export type ModelFindings = z.infer<typeof FindingsSchema>;

/** Anything that turns (system, user) prompts into the model's JSON answer (object or JSON text). */
export type FindingsModel = (prompt: { system: string; user: string }) => Promise<unknown>;

export type FindingsPath = "messages-api" | "agent-sdk" | "custom" | "heuristic";

export type FindingsOptions = {
  flow: Flow;
  personas?: Record<string, Persona>;
  /** Inject a model (tests); otherwise chosen from env. */
  model?: FindingsModel;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export type FindingsResult = { findings: Finding[]; path: FindingsPath; error?: string };

const SYSTEM = `You are a senior UX researcher analysing a synthetic usability test of a web checkout.
Simulated shoppers (personas with perception limits) tried to complete a goal. You get their give-up reasons,
think-aloud notes, detected friction signals and the metrics. Cluster them into distinct, ranked findings
(most severe first: blockers that made shoppers give up, then confusion, then minor friction).
Rules:
- Only cite screenshots from "screenshots" and quotes copied verbatim from the notes. Never invent evidence.
- "page" is the flow route of the step (e.g. "/checkout"). "selector" is the element involved, or null.
- "personas" are persona ids. "agentCount" is the number of distinct agents affected.
- "suggestedFix" is one concrete, minimal UI change that keeps every required step and field.
- Merge signals about the same problem. Skip noise with no user impact.
Answer with JSON only: {"findings": [...]}.`;

export function buildPrompt(run: RunData, metrics: Metrics, signals: FrictionSignal[], opts: FindingsOptions) {
  const personas = opts.personas ?? PERSONAS;
  const input = {
    goal: opts.flow.goal,
    steps: opts.flow.steps.map((s) => `${s.name} = ${s.route}`),
    requiredSteps: opts.flow.required.steps,
    personas: metrics.personas.map((m) => ({
      id: m.personaId,
      name: personas[m.personaId]?.name,
      control: !!personas[m.personaId]?.control,
      n: m.n,
      completed: m.completed,
      gaveUp: m.gaveUp,
      invalidCompletions: m.invalidCompletions,
      droppedAt: m.funnel.filter((f) => f.droppedHere).map((f) => `${f.step} (${f.droppedHere})`),
    })),
    signals: signals.map(({ ts: _, ...s }) => s),
    screenshots: [...new Set(run.events.map((e) => e.screenshot).filter(Boolean))],
  };
  return {
    system: SYSTEM,
    user: `Run ${run.config.runId}. Data:\n${JSON.stringify(input, null, 1)}\n\nReturn the findings JSON.`,
  };
}

const extractJson = (x: unknown): unknown => {
  if (typeof x !== "string") return x;
  const t = x.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  return JSON.parse(start > 0 ? t.slice(start, t.lastIndexOf("}") + 1) : t);
};

/** Validate model output and drop evidence that isn't in the input; renumber F1..Fn. */
export function sanitizeFindings(raw: unknown, run: RunData): Finding[] {
  const parsed = FindingsSchema.parse(extractJson(raw));
  const shots = new Set(run.events.map((e) => e.screenshot).filter(Boolean));
  const notes = run.events.map((e) => e.note?.trim()).filter((n): n is string => !!n);
  const personaIds = new Set(run.events.map((e) => e.personaId));
  const agents = new Set(run.events.map((e) => e.agentId)).size;
  return parsed.findings
    .map((f) => ({ ...f, personas: f.personas.filter((p) => personaIds.has(p)) }))
    .filter((f) => f.personas.length)
    .map(({ selector, ...f }, i): Finding => ({
      ...f,
      id: `F${i + 1}`,
      ...(selector ? { selector } : {}),
      evidence: {
        screenshots: [...new Set(f.evidence.screenshots.filter((s) => shots.has(s)))],
        quotes: [...new Set(f.evidence.quotes.map((q) => q.trim()).filter((q) => q && notes.some((n) => n.includes(q))))],
        agentCount: Math.max(1, Math.min(agents, Math.round(f.evidence.agentCount))),
      },
    }));
}

function messagesApiModel(apiKey: string, timeoutMs: number): FindingsModel {
  return async ({ system, user }) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    const res = await client.messages.parse({
      model: FINDINGS_MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(FindingsSchema) },
    });
    if (res.stop_reason === "refusal") throw new Error("model refused");
    if (!res.parsed_output) throw new Error(`no parsed output (stop_reason ${res.stop_reason})`);
    return res.parsed_output;
  };
}

function agentSdkModel(oauthToken: string, timeoutMs: number): FindingsModel {
  return async ({ system, user }) => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    const { ANTHROPIC_API_KEY: _, ...env } = process.env;
    try {
      for await (const msg of query({
        prompt: user,
        options: {
          model: FINDINGS_MODEL,
          systemPrompt: system,
          tools: [],
          maxTurns: 1,
          settingSources: [],
          persistSession: false,
          abortController,
          env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
        },
      })) {
        if (msg.type !== "result") continue;
        if (msg.subtype !== "success" || msg.is_error) throw new Error(`agent sdk result: ${msg.subtype}`);
        return msg.result;
      }
      throw new Error("agent sdk returned no result");
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Pick the model by auth: ANTHROPIC_API_KEY → Messages API; CLAUDE_CODE_OAUTH_TOKEN → Agent SDK; else none. */
export function modelFromEnv(env: Record<string, string | undefined>, timeoutMs: number) {
  if (env.ANTHROPIC_API_KEY) return { path: "messages-api" as const, model: messagesApiModel(env.ANTHROPIC_API_KEY, timeoutMs) };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { path: "agent-sdk" as const, model: agentSdkModel(env.CLAUDE_CODE_OAUTH_TOKEN, timeoutMs) };
  return undefined;
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref())]);

/** Sonnet clusters friction into ranked findings; any failure falls back to the deterministic heuristic. */
export async function generateFindings(run: RunData, metrics: Metrics, opts: FindingsOptions): Promise<FindingsResult> {
  const signals = frictionSignals(opts.flow, run.events);
  const heuristic = () => heuristicFindings(opts.flow, run.events, signals);
  if (!signals.length) return { findings: [], path: "heuristic" };
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const chosen = opts.model
    ? { path: "custom" as const, model: opts.model }
    : modelFromEnv(opts.env ?? process.env, timeoutMs);
  if (!chosen) return { findings: heuristic(), path: "heuristic" };
  try {
    const raw = await withTimeout(chosen.model(buildPrompt(run, metrics, signals, opts)), timeoutMs);
    const findings = sanitizeFindings(raw, run);
    if (!findings.length) throw new Error("model returned no usable findings");
    return { findings, path: chosen.path };
  } catch (err) {
    const error = `${chosen.path} failed: ${err instanceof Error ? err.message : String(err)}`;
    opts.log?.(`${error}; using heuristic findings`);
    return { findings: heuristic(), path: "heuristic", error };
  }
}
