import Anthropic from "@anthropic-ai/sdk";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

let cached: Anthropic | null | undefined;

function client(): Anthropic | null {
  if (cached !== undefined) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  cached = apiKey ? new Anthropic({ apiKey }) : null;
  return cached;
}

export function hasLLM(): boolean {
  return client() !== null;
}

export async function generateReply(
  system: string,
  history: Turn[],
  userText: string,
): Promise<string> {
  const c = client();
  if (!c) throw new Error("No ANTHROPIC_API_KEY configured");

  const response = await c.messages.create({
    model: process.env.VERITY_MODEL ?? "claude-sonnet-4-5",
    max_tokens: 400,
    system,
    messages: [...history, { role: "user", content: userText }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
