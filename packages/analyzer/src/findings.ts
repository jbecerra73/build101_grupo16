import { z } from "zod";
import { PERSONAS, type Finding, type Flow, type Metrics, type Persona } from "@frictionswarm/shared";
import { heuristicFindings } from "./heuristic";
import type { RunData } from "./run";
import { frictionSignals, type FrictionSignal } from "./signals";
import { giveUpAgents, heuristicThemes, ModelThemeSchema, sanitizeThemes, type Theme } from "./themes";

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

/** The full model answer: findings and give-up themes in one call (structured-output schema). */
export const AnswerSchema = FindingsSchema.extend({ themes: z.array(ModelThemeSchema) });
/** Parsing is lenient about themes: an answer without them keeps its findings and gets heuristic themes. */
const LenientAnswerSchema = FindingsSchema.extend({ themes: z.array(z.unknown()).optional() });

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

export type FindingsResult = {
  findings: Finding[];
  themes: Theme[];
  path: FindingsPath;
  /** Where the themes came from: the model path, or "heuristic" when its themes were missing or unusable. */
  themesPath: FindingsPath;
  error?: string;
};

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
Also group the give-up reasons ("giveUps") into themes: the underlying reasons shoppers left, in plain words
(e.g. "Could not see how to continue", "Refused a forced sign-up"), not just the step name.
- Every agent in "giveUps" belongs to exactly one theme ("agentIds"). Merge agents that left for the same reason.
- "quotes" are copied verbatim from that agent's notes, with its agentId.
- "findingIds" are the findings describing the same problem, by position in your findings list ("F1" = first).
- No give-ups means "themes": [].
Answer with JSON only, no prose, exactly this shape (all keys required):
{"findings": [{"severity": "high" | "medium" | "low", "personas": ["<persona id>"], "step": "<step name>",
  "page": "<route>", "selector": "<css selector>" | null, "title": "<short problem statement>",
  "evidence": {"screenshots": ["<path>"], "quotes": ["<verbatim note>"], "agentCount": <number>},
  "suggestedFix": "<one concrete change>"}],
 "themes": [{"title": "<short reason>", "agentIds": ["<agent id>"],
  "quotes": [{"agentId": "<agent id>", "text": "<verbatim note>"}], "findingIds": ["F<n>"]}]}`;

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
    giveUps: [...giveUpAgents(run.events)].map(([agentId, a]) => ({ agentId, personaId: a.personaId, step: a.step, notes: a.notes })),
    screenshots: [...new Set(run.events.map((e) => e.screenshot).filter(Boolean))],
  };
  return {
    system: SYSTEM,
    user: `Run ${run.config.runId}. Data:\n${JSON.stringify(input, null, 1)}\n\nReturn the findings and themes JSON.`,
  };
}

/** Parse a JSON answer, tolerating code fences and prose around the first balanced object. */
export function extractJson(x: unknown): unknown {
  if (typeof x !== "string") return x;
  try {
    return JSON.parse(x);
  } catch {}
  const start = x.indexOf("{");
  let depth = 0, inStr = false, esc = false;
  for (let i = Math.max(0, start); i < x.length; i++) {
    const c = x[i];
    if (inStr) [esc, inStr] = [c === "\\" && !esc, esc || c !== '"'];
    else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(x.slice(start, i + 1));
  }
  throw new Error(`no JSON object in model answer: ${x.slice(0, 120)}`);
}

export type SanitizedAnswer = {
  findings: Finding[];
  /** Undefined when the answer had no usable themes (the caller falls back to heuristic themes). */
  themes?: Theme[];
  /** Number of findings in the raw answer, before dropping unusable ones. */
  rawFindings: number;
};

/** Validate model output and drop evidence that isn't in the input; renumber F1..Fn.
 * Themes keep only agents that gave up and quotes found in that agent's notes. */
export function sanitizeAnswer(raw: unknown, run: RunData): SanitizedAnswer {
  const parsed = LenientAnswerSchema.parse(extractJson(raw));
  const shots = new Set(run.events.map((e) => e.screenshot).filter(Boolean));
  const notes = run.events.map((e) => e.note?.trim()).filter((n): n is string => !!n);
  const personaIds = new Set(run.events.map((e) => e.personaId));
  const agents = new Set(run.events.map((e) => e.agentId)).size;
  const kept = parsed.findings
    .map((f, i) => ({ ...f, modelId: `F${i + 1}`, personas: f.personas.filter((p) => personaIds.has(p)) }))
    .filter((f) => f.personas.length);
  const idMap = new Map(kept.map((f, i) => [f.modelId, `F${i + 1}`]));
  const findings = kept.map(({ selector, modelId: _, ...f }, i): Finding => ({
    ...f,
    id: `F${i + 1}`,
    ...(selector ? { selector } : {}),
    evidence: {
      screenshots: [...new Set(f.evidence.screenshots.filter((s) => shots.has(s)))],
      quotes: [...new Set(f.evidence.quotes.map((q) => q.trim()).filter((q) => q && notes.some((n) => n.includes(q))))],
      agentCount: Math.max(1, Math.min(agents, Math.round(f.evidence.agentCount))),
    },
  }));
  const rawThemes = z.array(ModelThemeSchema).safeParse(parsed.themes);
  const themes = rawThemes.success ? sanitizeThemes(rawThemes.data, run.events, idMap) : undefined;
  // With give-ups in the run, an empty theme list is not a usable answer.
  const usable = themes && (themes.length > 0 || giveUpAgents(run.events).size === 0);
  return { findings, themes: usable ? themes : undefined, rawFindings: parsed.findings.length };
}

/** Findings only (see sanitizeAnswer). */
export const sanitizeFindings = (raw: unknown, run: RunData): Finding[] => sanitizeAnswer(raw, run).findings;

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
      output_config: { format: zodOutputFormat(AnswerSchema) },
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

/** Sonnet clusters friction into ranked findings and give-up themes in one call; any failure
 * falls back to the deterministic heuristic (themes alone fall back when only they are unusable). */
export async function generateFindings(run: RunData, metrics: Metrics, opts: FindingsOptions): Promise<FindingsResult> {
  const signals = frictionSignals(opts.flow, run.events);
  const heuristic = (error?: string): FindingsResult => {
    const findings = heuristicFindings(opts.flow, run.events, signals);
    return { findings, themes: heuristicThemes(run.events, findings), path: "heuristic", themesPath: "heuristic", ...(error ? { error } : {}) };
  };
  if (!signals.length) return heuristic();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const chosen = opts.model
    ? { path: "custom" as const, model: opts.model }
    : modelFromEnv(opts.env ?? process.env, timeoutMs);
  if (!chosen) return heuristic();
  const prompt = buildPrompt(run, metrics, signals, opts);
  let error = "";
  // One retry for malformed answers; timeouts and API errors go straight to the heuristic.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: unknown;
    try {
      raw = await withTimeout(chosen.model(prompt), timeoutMs);
    } catch (err) {
      error = `${chosen.path} failed: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    try {
      const answer = sanitizeAnswer(raw, run);
      // An explicit empty list is a valid answer (e.g. a clean retest where the
      // only signals are noise); only fall back when findings were all dropped.
      if (!answer.findings.length && answer.rawFindings) throw new Error("model returned no usable findings");
      if (answer.themes) return { findings: answer.findings, themes: answer.themes, path: chosen.path, themesPath: chosen.path };
      opts.log?.(`${chosen.path}: no usable themes in the answer; using heuristic themes`);
      return { findings: answer.findings, themes: heuristicThemes(run.events, answer.findings), path: chosen.path, themesPath: "heuristic" };
    } catch (err) {
      error = `${chosen.path} failed: invalid answer (${err instanceof Error ? err.message.slice(0, 300) : String(err)})`;
      opts.log?.(`${error}${attempt === 1 ? "; retrying" : ""}`);
    }
  }
  opts.log?.(`${error}; using heuristic findings`);
  return heuristic(error);
}
