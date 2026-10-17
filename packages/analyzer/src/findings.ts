// Findings: a Sonnet 5.5 pass clusters aggregated signals (never raw events) into ranked
// findings, citing signal ids; the evidence (sessions, users, rates, release, example sessions)
// is computed by code from the cited signals, so the model can't invent it. Messages API
// (ANTHROPIC_API_KEY) → Agent SDK (CLAUDE_CODE_OAUTH_TOKEN) → deterministic heuristic.
import { z } from "zod";
import { PERSONAS, SEGMENTS, type Finding, type Flow, type Metrics, type RunKind, type SegmentId, type Severity } from "@frictionswarm/shared";
import { buildEvidence, clusterGroups, groupsOfSegments, heuristicFindings, segmentsFor, shareFor, type FindingContext } from "./heuristic";
import type { History } from "./history";
import type { SessionSummary } from "./sessions";
import type { Signal } from "./signals";
import { giveUpAgents, heuristicThemes, ModelThemeSchema, sanitizeThemes, type Theme } from "./themes";

export const FINDINGS_MODEL = "claude-sonnet-5-5";

const SEGMENT_IDS = SEGMENTS.map((s) => s.id) as [SegmentId, ...SegmentId[]];

export const ModelFindingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  /** Signal ids ("S3") this finding explains. */
  signalIds: z.array(z.string()),
  segments: z.array(z.enum(SEGMENT_IDS)),
  step: z.string(),
  page: z.string(),
  selector: z.string().nullable(),
  title: z.string(),
  suggestedFix: z.string(),
  /** Verbatim swarm notes (retest only). */
  quotes: z.array(z.string()),
});
export const FindingsSchema = z.object({ findings: z.array(ModelFindingSchema) });
/** The full model answer: findings and (retest) give-up themes in one call. */
export const AnswerSchema = FindingsSchema.extend({ themes: z.array(ModelThemeSchema) });
/** Parsing is lenient about themes: an answer without them keeps its findings and gets heuristic themes. */
const LenientAnswerSchema = FindingsSchema.extend({ themes: z.array(z.unknown()).optional() });
export type ModelAnswer = z.infer<typeof AnswerSchema>;

/** Anything that turns (system, user) prompts into the model's JSON answer (object or JSON text). */
export type FindingsModel = (prompt: { system: string; user: string }) => Promise<unknown>;

export type FindingsPath = "messages-api" | "agent-sdk" | "custom" | "heuristic";

export type FindingsInput = {
  runId: string;
  kind: RunKind;
  flow: Flow;
  metrics: Metrics;
  sessions: SessionSummary[];
  signals: Signal[];
  history?: History;
};

export type FindingsOptions = {
  /** Inject a model (tests); otherwise chosen from env. */
  model?: FindingsModel;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Signals sent to the model (strong ones first). Default 30. */
  maxSignals?: number;
  log?: (line: string) => void;
};

export type FindingsResult = {
  findings: Finding[];
  themes: Theme[];
  path: FindingsPath;
  /** Where the themes came from: the model path, or "heuristic". */
  themesPath: FindingsPath;
  error?: string;
};

const SYSTEM = `You are a senior UX researcher reading a web shop's product analytics (PostHog).
You get the checkout funnel, aggregated friction signals and, for a swarm re-test, the AI shoppers' give-up notes.
Real users are split into segments (low_vision = large text or high contrast, mobile, desktop = control);
a swarm re-test has personas standing in for them (rosa → low_vision, kai → mobile, typical → desktop).
Cluster the signals into distinct, ranked findings: the problems that cost the most orders first.
Rules:
- Every finding cites the signals it explains by id ("signalIds"). Never invent numbers; evidence is computed from the cited signals.
- Merge signals about the same problem (e.g. rage clicks, failed submits and the drop-off at the same element or step).
  Keep different problems apart even on the same step (e.g. a form wiped by a promo code vs a hidden button).
- Skip noise with no user impact (ordinary browsing exits, declined cards).
- "segments" are the segment ids the problem hurts most (for a re-test, the segments of the affected personas).
- "step" is the funnel step name, "page" its route, "selector" the element to change (or null).
- "title" says what goes wrong for whom, in plain words. "suggestedFix" is one concrete, minimal UI change
  that keeps every required step and field.
- "quotes" are copied verbatim from the swarm notes given (re-test only); otherwise [].
- "severity": high = blocks many orders, medium = loses some, low = annoyance.
For a re-test, also group the give-ups ("giveUps") into themes: the underlying reasons the agents left, in plain words.
Each agent in "giveUps" belongs to exactly one theme ("agentIds"); "quotes" are verbatim from that agent's notes,
with its agentId; "findingIds" are positions in your findings list ("F1" = first). No give-ups (or an analysis) means "themes": [].
Answer with JSON only, exactly this shape (all keys required):
{"findings": [{"severity": "high" | "medium" | "low", "signalIds": ["S1"], "segments": ["low_vision" | "mobile" | "desktop"],
  "step": "<step name>", "page": "<route>", "selector": "<selector>" | null, "title": "<problem>",
  "suggestedFix": "<one change>", "quotes": ["<verbatim note>"]}],
 "themes": [{"title": "<short reason>", "agentIds": ["<agent id>"], "quotes": [{"agentId": "<agent id>", "text": "<verbatim note>"}], "findingIds": ["F<n>"]}]}`;

const pct = (x: number) => Math.round(x * 1000) / 10;

/** Compact model input: the funnel per group and aggregated signals, no raw events. */
export function buildPrompt(input: FindingsInput, opts: FindingsOptions = {}) {
  const { flow, metrics, kind } = input;
  const groups =
    kind === "retest"
      ? metrics.personas.map((p) => ({
          persona: p.personaId,
          segment: SEGMENTS.find((s) => s.personaId === p.personaId)?.id,
          control: !!PERSONAS[p.personaId]?.control,
          n: p.n,
          completionRate: pct(p.completionRate),
          droppedAt: p.funnel.filter((f) => f.droppedHere).map((f) => `${f.step} ${f.droppedHere}`),
        }))
      : metrics.segments.map((s) => ({
          segment: s.segmentId,
          n: s.n,
          users: s.users,
          completionRate: pct(s.completionRate),
          funnel: s.funnel.map((f) => `${f.step} ${f.reached} reached, ${f.droppedHere} left`),
        }));
  const signals = input.signals.slice(0, opts.maxSignals ?? 30).map((s) => ({
    id: s.id,
    kind: s.kind,
    step: s.step,
    page: s.page,
    ...(s.selector && { selector: s.selector }),
    ...(s.label && { label: s.label }),
    ...(s.event && { event: s.event }),
    ...(s.fields && { errorFields: s.fields }),
    sessions: s.sessions,
    users: s.users,
    events: s.events,
    leftAtStep: s.exits,
    byGroup: s.groups.map((g) => `${g.id}: ${g.sessions}/${g.reached} (${pct(g.rate)}%)${g.exitDwellMs !== undefined ? `, exit dwell ${Math.round(g.exitDwellMs / 1000)}s` : ""}`),
    ...(s.dwell && { dwell: `${s.dwell.class}: exits after ${Math.round(s.dwell.exitMedianMs / 1000)}s vs ${Math.round(s.dwell.passMedianMs / 1000)}s for those who continue` }),
    ...(s.sinceRelease && { sinceRelease: `${s.sinceRelease.name} (${s.sinceRelease.date})` }),
    strong: s.strong,
    ...(s.quotes.length && { quotes: s.quotes }),
  }));
  const data = {
    run: input.runId,
    kind,
    goal: flow.goal,
    steps: flow.steps.map((s) => `${s.name} = ${s.route}`),
    requiredSteps: flow.required.steps,
    ...(input.history && { releases: input.history.releases.map((r) => `${r.date} ${r.name}`) }),
    groups,
    signals,
    ...(kind === "retest" && {
      giveUps: [...giveUpAgents(input.sessions)].map(([agentId, g]) => ({ agentId, personaId: g.personaId, step: g.step, notes: g.notes })),
    }),
  };
  return { system: SYSTEM, user: `Data:\n${JSON.stringify(data, null, 1)}\n\nReturn the findings and themes JSON.` };
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

export type SanitizedAnswer = { findings: Finding[]; themes?: Theme[]; rawFindings: number };

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Validate the model's answer against the input: only cited signals that exist, segments that
 * exist, quotes copied from swarm notes; evidence recomputed from the cited signals. Renumbers F1..Fn. */
export function sanitizeAnswer(raw: unknown, input: FindingsInput): SanitizedAnswer {
  const parsed = LenientAnswerSchema.parse(extractJson(raw));
  const byId = new Map(input.signals.map((s) => [s.id, s]));
  const notes = input.sessions.flatMap((s) => s.notes.map((n) => n.text));
  const steps = new Set(input.flow.steps.map((s) => s.name));
  const ctx: FindingContext = { flow: input.flow, kind: input.kind, sessions: input.sessions };
  const kept = parsed.findings.flatMap((f, i) => {
    const cited = [...new Set(f.signalIds)].map((id) => byId.get(id)).filter((s): s is Signal => !!s);
    if (!cited.length) return [];
    const step = steps.has(f.step) ? f.step : cited[0].step;
    let groupIds = groupsOfSegments(input.kind, f.segments);
    if (!groupIds.length) groupIds = clusterGroups(cited, input.kind === "retest" ? 1 : 3, shareFor(input.kind));
    const { segments, personas } = segmentsFor(input.kind, groupIds);
    if (!segments.length) return [];
    const evidence = buildEvidence(ctx, cited, groupsOfSegments(input.kind, segments), step);
    const quotes = [...new Set(f.quotes.map((q) => q.trim()).filter((q) => q && notes.some((n) => n.includes(q))))];
    const page = input.flow.steps.find((s) => s.name === step)?.route.split("?")[0] ?? cited[0].page;
    const finding: Finding = {
      id: "",
      severity: f.severity,
      segments,
      personas,
      step,
      page,
      ...(f.selector ? { selector: f.selector } : {}),
      title: f.title.trim(),
      evidence: { ...evidence, quotes: quotes.length ? quotes : evidence.quotes },
      suggestedFix: f.suggestedFix.trim(),
    };
    return [{ modelId: `F${i + 1}`, finding }];
  });
  kept.sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity]);
  const idMap = new Map(kept.map((k, i) => [k.modelId, `F${i + 1}`]));
  const findings = kept.map((k, i) => ({ ...k.finding, id: `F${i + 1}` }));
  let themes: Theme[] | undefined;
  if (input.kind === "retest") {
    const rawThemes = z.array(ModelThemeSchema).safeParse(parsed.themes);
    themes = rawThemes.success ? sanitizeThemes(rawThemes.data, input.sessions, idMap) : undefined;
    if (themes && !themes.length && giveUpAgents(input.sessions).size) themes = undefined;
  } else themes = heuristicThemes("analysis", input.sessions, findings);
  return { findings, themes, rawFindings: parsed.findings.length };
}

function messagesApiModel(apiKey: string, timeoutMs: number): FindingsModel {
  return async ({ system, user }) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { betaZodOutputFormat } = await import("@anthropic-ai/sdk/helpers/beta/zod");
    const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    const res = await client.beta.messages.parse({
      model: FINDINGS_MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: betaZodOutputFormat(AnswerSchema) },
      // Server-side fallback if Sonnet declines on policy grounds.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
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

/** Sonnet clusters signals into ranked findings (and, on a retest, give-up themes) in one call;
 * one retry for malformed answers; any failure falls back to the deterministic heuristic. */
export async function generateFindings(input: FindingsInput, opts: FindingsOptions = {}): Promise<FindingsResult> {
  const ctx: FindingContext = { flow: input.flow, kind: input.kind, sessions: input.sessions };
  const heuristic = (error?: string): FindingsResult => {
    const findings = heuristicFindings(ctx, input.signals);
    return {
      findings,
      themes: heuristicThemes(input.kind, input.sessions, findings),
      path: "heuristic",
      themesPath: "heuristic",
      ...(error ? { error } : {}),
    };
  };
  if (!input.signals.length) return heuristic();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const chosen = opts.model ? { path: "custom" as const, model: opts.model } : modelFromEnv(opts.env ?? process.env, timeoutMs);
  if (!chosen) return heuristic();
  const prompt = buildPrompt(input, opts);
  let error = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: unknown;
    try {
      raw = await withTimeout(chosen.model(prompt), timeoutMs);
    } catch (err) {
      error = `${chosen.path} failed: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    try {
      const answer = sanitizeAnswer(raw, input);
      if (!answer.findings.length && answer.rawFindings) throw new Error("model returned no usable findings");
      if (answer.themes) return { findings: answer.findings, themes: answer.themes, path: chosen.path, themesPath: input.kind === "retest" ? chosen.path : "heuristic" };
      opts.log?.(`${chosen.path}: no usable themes in the answer; using heuristic themes`);
      return { findings: answer.findings, themes: heuristicThemes(input.kind, input.sessions, answer.findings), path: chosen.path, themesPath: "heuristic" };
    } catch (err) {
      error = `${chosen.path} failed: invalid answer (${err instanceof Error ? err.message.slice(0, 300) : String(err)})`;
      opts.log?.(`${error}${attempt === 1 ? "; retrying" : ""}`);
    }
  }
  opts.log?.(`${error}; using heuristic findings`);
  return heuristic(error);
}

