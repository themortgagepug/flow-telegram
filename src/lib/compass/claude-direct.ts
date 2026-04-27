// Direct Anthropic SDK call for Compass conversational mode.
// Bypasses the Agent SDK + MCP tools used by the ops bot, since Coach
// only needs to think and reply, not call tools.

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

const MODEL = "claude-opus-4-5";
const FALLBACK_MODEL = "claude-sonnet-4-5";

export interface CompassChatInput {
  systemPrompt: string;
  userMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface CompassChatResult {
  text: string;
  error?: string;
  model?: string;
}

export async function compassChat(input: CompassChatInput): Promise<CompassChatResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: "", error: "ANTHROPIC_API_KEY missing" };
  }

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...input.history,
    { role: "user", content: input.userMessage },
  ];

  for (const model of [MODEL, FALLBACK_MODEL]) {
    try {
      const r = await client.messages.create({
        model,
        max_tokens: 1500,
        system: input.systemPrompt,
        messages,
      });
      const block = r.content?.[0];
      const text = block && block.type === "text" ? block.text : "";
      return { text, model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (model === FALLBACK_MODEL) {
        return { text: "", error: msg, model };
      }
      // try fallback
    }
  }

  return { text: "", error: "all models failed" };
}
