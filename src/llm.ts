export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export type Wire = "anthropic" | "openai";

type Json = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const MAX_TOKENS = 400;

function asJson(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null ? (value as Json) : undefined;
}

function baseUrl(): string {
  return (process.env.VERITY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function modelId(): string {
  return process.env.VERITY_MODEL ?? DEFAULT_MODEL;
}

function apiKey(): string | undefined {
  return process.env.COMMANDCODE_API_KEY;
}

/** Claude only speaks on /v1/messages; OpenAI and open models on /v1/chat/completions. */
export function wireFor(model: string): Wire {
  const override = process.env.VERITY_WIRE;
  if (override === "anthropic" || override === "openai") return override;
  return model.startsWith("claude") ? "anthropic" : "openai";
}

export function hasLLM(): boolean {
  return Boolean(apiKey());
}

export function backend(): string {
  if (!hasLLM()) return "scripted fallback (no COMMANDCODE_API_KEY)";
  const model = modelId();
  return `${model} via ${wireFor(model)} wire on Command Code Provider API`;
}

export interface RequestPlan {
  url: string;
  body: Json;
}

export function buildRequest(
  wire: Wire,
  root: string,
  model: string,
  system: string,
  history: Turn[],
  userText: string,
): RequestPlan {
  const turns: Turn[] = [...history, { role: "user", content: userText }];

  if (wire === "anthropic") {
    return {
      url: `${root}/messages`,
      body: { model, max_tokens: MAX_TOKENS, system, messages: turns },
    };
  }

  return {
    url: `${root}/chat/completions`,
    body: {
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: system }, ...turns],
    },
  };
}

function describeError(status: number, payload: unknown): string {
  const envelope = asJson(asJson(payload)?.["error"]);
  const message = envelope?.["message"];
  const kind = envelope?.["type"] ?? envelope?.["code"];
  if (typeof message === "string" && message) {
    return `Provider API ${status}${typeof kind === "string" ? ` (${kind})` : ""}: ${message}`;
  }
  return `Provider API ${status}`;
}

function extractText(wire: Wire, payload: unknown): string {
  const json = asJson(payload);
  if (!json) return "";

  if (wire === "anthropic") {
    const content = json["content"];
    if (!Array.isArray(content)) return "";
    const text = content
      .map(asJson)
      .filter(
        (block): block is Json =>
          block !== undefined && block["type"] === "text" && typeof block["text"] === "string",
      )
      .map((block) => block["text"] as string)
      .join("\n");
    return text.trim();
  }

  const choices = json["choices"];
  if (!Array.isArray(choices)) return "";
  const text = choices
    .map((choice) => asJson(asJson(choice)?.["message"])?.["content"])
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return text.trim();
}

export async function generateReply(
  system: string,
  history: Turn[],
  userText: string,
): Promise<string> {
  const key = apiKey();
  if (!key) throw new Error("COMMANDCODE_API_KEY is not set");

  const model = modelId();
  const wire = wireFor(model);
  const plan = buildRequest(wire, baseUrl(), model, system, history, userText);

  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  if (process.env.CMD_ZDR === "1") headers["x-cmd-zdr"] = "1";

  const response = await fetch(plan.url, {
    method: "POST",
    headers,
    body: JSON.stringify(plan.body),
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(describeError(response.status, payload));

  const text = extractText(wire, payload);
  if (!text) throw new Error(`Provider API ${response.status}: empty response`);
  return text;
}
