import { query } from "@anthropic-ai/claude-agent-sdk";
import { flowMcpServer, flowToolNames } from "./mcp-tools";

export type ChatInput = {
  systemPrompt: string;
  userMessage: string;
  imagePath?: string; // Local filesystem path to an image, if any
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

export type ChatResult = {
  text: string;
  costUsd: number;
  error?: string;
};

/**
 * Send a message to Claude via the Agent SDK (uses local Claude Code OAuth).
 * Returns the final text response after tool calls complete.
 */
export async function chatWithClaude(input: ChatInput): Promise<ChatResult> {
  const { systemPrompt, userMessage, imagePath, history = [] } = input;

  // Build conversation history into a single prompt
  const historyText = history
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
    .join("\n\n");

  const imageNote = imagePath
    ? `\n\nThe user attached an image. Read it from: ${imagePath}\n`
    : "";

  const fullPrompt = [
    historyText ? `Previous conversation:\n${historyText}\n\n---\n` : "",
    `User message: ${userMessage}`,
    imageNote,
  ]
    .filter(Boolean)
    .join("");

  let finalText = "";
  let totalCost = 0;

  try {
    for await (const msg of query({
      prompt: fullPrompt,
      options: {
        systemPrompt,
        mcpServers: { "flow-tools": flowMcpServer },
        allowedTools: [...flowToolNames, "Read"],
        permissionMode: "bypassPermissions",
        maxTurns: 8,
      },
    })) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            finalText = block.text;
          }
        }
      }
      if (msg.type === "result") {
        totalCost = (msg as { total_cost_usd?: number }).total_cost_usd || 0;
        if (msg.subtype !== "success") {
          return {
            text: finalText || "I couldn't process that. Try rephrasing.",
            costUsd: totalCost,
            error: msg.subtype,
          };
        }
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[Claude] Query error:", errMsg);
    return {
      text: "Something went wrong. Try again or rephrase your request.",
      costUsd: 0,
      error: errMsg,
    };
  }

  return {
    text: finalText || "Done.",
    costUsd: totalCost,
  };
}
