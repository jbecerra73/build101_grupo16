import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, type Observation } from "./observe";

export type ToolName = "click" | "type" | "scroll" | "back" | "think_aloud" | "give_up" | "done";

export type ToolCall = { id: string; name: ToolName; input: Record<string, unknown> };

/** What happened when a ToolCall ran, reported back to the brain. */
export type ToolOutcome = { call: ToolCall; result: string; isError?: boolean };

/** Decides the agent's next tool calls. The agent loop is model-agnostic so tests can script it. */
export interface Brain {
  decide(turn: { outcomes: ToolOutcome[]; observation: Observation }): Promise<ToolCall[]>;
}

/** Model ids starting with "claude-" use the Anthropic API; anything else goes to an
 * OpenAI-compatible endpoint (default: OpenCode Zen, which serves DeepSeek). */
export const DEFAULT_AGENT_MODEL = () => process.env.AGENT_MODEL ?? "deepseek-v4.1-flash";
const DEFAULT_OPENAI_BASE_URL = "https://opencode.ai/inference/openai/v1";

export function createBrain(system: string, model = DEFAULT_AGENT_MODEL()): Brain {
  if (model.startsWith("claude-")) return new ClaudeBrain(system, model);
  const apiKey = process.env.AGENT_API_KEY ?? process.env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error(`Set AGENT_API_KEY or OPENCODE_API_KEY to use ${model}`);
  return new OpenAIBrain(system, model, new OpenAI({ apiKey, baseURL: process.env.AGENT_BASE_URL ?? DEFAULT_OPENAI_BASE_URL, maxRetries: 4 }));
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "click",
    description: "Click (or tap) an element by its id from the element list, e.g. \"e7\".",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Element id, e.g. e7" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Replace the text in an input field with `text`. Set submit=true to press Enter afterwards.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Element id of the input, e.g. e3" },
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the page up or down by most of a screen.",
    input_schema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down"] } },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "back",
    description: "Go back to the previous page, like the browser back button.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "think_aloud",
    description:
      "Say what you are thinking or feeling right now, in first person and in character (one or two short sentences). Does not use up an action.",
    input_schema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "give_up",
    description: "Abandon the purchase, as a real shopper would. Explain why in first person.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "done",
    description: "Call when you believe the goal is fully completed (order placed and confirmed).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const png = (b: Buffer): Anthropic.ImageBlockParam => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: b.toString("base64") },
});

const observationBlocks = (o: Observation): (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] => [
  png(o.screenshot),
  { type: "text", text: describe(o) },
];

export class ClaudeBrain implements Brain {
  private readonly client: Anthropic;
  private readonly messages: Anthropic.MessageParam[] = [];

  constructor(
    private readonly system: string,
    private readonly model: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ maxRetries: 4 });
  }

  async decide({ outcomes, observation }: { outcomes: ToolOutcome[]; observation: Observation }) {
    this.dropOldScreenshots();
    if (outcomes.length === 0) {
      this.messages.push({
        role: "user",
        content: [
          ...observationBlocks(observation),
          { type: "text", text: "This is what you see now. Use a tool to act." },
        ],
      });
    } else {
      // The newest observation rides along with the last tool result.
      const results: Anthropic.ToolResultBlockParam[] = outcomes.map((o, i) => ({
        type: "tool_result",
        tool_use_id: o.call.id,
        is_error: o.isError,
        content:
          i === outcomes.length - 1
            ? [{ type: "text", text: o.result }, ...observationBlocks(observation)]
            : o.result,
      }));
      this.messages.push({ role: "user", content: results });
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: this.system,
      tools: TOOLS,
      messages: this.messages,
    });
    this.messages.push({ role: "assistant", content: response.content });

    return response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name as ToolName, input: b.input as Record<string, unknown> }));
  }

  /** Only the latest screenshot is worth its tokens; older ones become a placeholder. */
  private dropOldScreenshots() {
    for (const m of this.messages) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      m.content = m.content.map((b) => {
        if (b.type === "image") return { type: "text", text: "[earlier screenshot]" };
        if (b.type === "tool_result" && Array.isArray(b.content))
          return {
            ...b,
            content: b.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[earlier screenshot]" } : c)),
          };
        return b;
      });
    }
  }
}

const EARLIER = "[earlier screenshot]";

/** Same tools over the OpenAI chat-completions format (used for DeepSeek via OpenCode Zen). */
export class OpenAIBrain implements Brain {
  private readonly messages: OpenAI.ChatCompletionMessageParam[];
  private readonly tools: OpenAI.ChatCompletionTool[] = TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema as Record<string, unknown> },
  }));

  constructor(
    system: string,
    private readonly model: string,
    private readonly client: OpenAI,
  ) {
    this.messages = [{ role: "system", content: system }];
  }

  async decide({ outcomes, observation }: { outcomes: ToolOutcome[]; observation: Observation }) {
    this.dropOldScreenshots();
    // Tool messages are text-only here, so the new screenshot goes in a user message after them.
    for (const o of outcomes)
      this.messages.push({ role: "tool", tool_call_id: o.call.id, content: o.isError ? `Error: ${o.result}` : o.result });
    this.messages.push({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${observation.screenshot.toString("base64")}` } },
        { type: "text", text: `${describe(observation)}\n\nThis is what you see now. Use a tool to act.` },
      ],
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      tools: this.tools,
      messages: this.messages,
    });
    const message = response.choices[0]?.message;
    if (!message) return [];
    // Push the message as returned so provider extras (e.g. DeepSeek reasoning_content) round-trip.
    this.messages.push(message as OpenAI.ChatCompletionAssistantMessageParam);

    return (message.tool_calls ?? []).flatMap((c) => {
      if (c.type !== "function") return [];
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        input = {};
      }
      return [{ id: c.id, name: c.function.name as ToolName, input }];
    });
  }

  private dropOldScreenshots() {
    for (const m of this.messages) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      m.content = m.content.map((p) => (p.type === "image_url" ? { type: "text" as const, text: EARLIER } : p));
    }
  }
}
