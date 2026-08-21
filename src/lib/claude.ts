import { TOOLS } from "./tools";
import { handleToolCall } from "./tool-handlers";
import { readFile } from "node:fs/promises";

// Gemini (free tier) + function-calling tool loop.
// Replaces both the Claude Agent SDK (no CLI in serverless) and the paid Anthropic API.
// Same exported shape as before so bot.ts needs no changes.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MAX_TOOL_TURNS = 8;

export type ChatInput = {
  systemPrompt: string;
  userMessage: string;
  imagePath?: string; // Local filesystem path to an image, if any
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  // Optional subset of base tool names (e.g. "zoho_create_lead"). Defaults to all.
  allowedToolNames?: string[];
};

export type ChatResult = { text: string; costUsd: number; error?: string };

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

// Convert our JSON-schema tool params into the OpenAPI-ish schema Gemini expects.
// Returns undefined for paramless tools (Gemini rejects empty-property objects).
function toGeminiParams(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) return undefined;
  return cleanSchema(schema);
}
function cleanSchema(s: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  if (s.type) out.type = s.type;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = cleanSchema(s.items);
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = cleanSchema(v);
  }
  if (s.required && s.required.length) out.required = s.required;
  return out;
}

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

export async function chatWithClaude(input: ChatInput): Promise<ChatResult> {
  const { systemPrompt, userMessage, imagePath, history = [], allowedToolNames } = input;

  if (!GEMINI_KEY) {
    return { text: "AI isn't configured yet (missing GEMINI_API_KEY).", costUsd: 0, error: "no_gemini_key" };
  }

  // Scope tools (team bot gets a subset).
  const selected = allowedToolNames && allowedToolNames.length
    ? TOOLS.filter((t) => allowedToolNames.includes(t.name))
    : TOOLS;
  const functionDeclarations = selected.map((t) => {
    const params = toGeminiParams(t.input_schema as unknown as JsonSchema);
    return params
      ? { name: t.name, description: t.description, parameters: params }
      : { name: t.name, description: t.description };
  });

  // History folded into the system instruction as plain text.
  const historyText = history
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
    .join("\n\n");
  const system = historyText ? `${systemPrompt}\n\n---\nRecent conversation:\n${historyText}` : systemPrompt;

  // First user turn (text + optional image).
  const userParts: Part[] = [];
  if (imagePath) {
    try {
      const buf = await readFile(imagePath);
      const mimeType = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      userParts.push({ inline_data: { mime_type: mimeType, data: buf.toString("base64") } });
    } catch (e) {
      console.error("[Gemini] image read error:", e);
    }
  }
  userParts.push({ text: userMessage });

  const contents: Content[] = [{ role: "user", parts: userParts }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;

  let finalText = "";
  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          ...(functionDeclarations.length ? { tools: [{ function_declarations: functionDeclarations }] } : {}),
          generationConfig: { maxOutputTokens: 2048, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
        }),
      });

      if (!res.ok) {
        const errTxt = (await res.text()).slice(0, 400);
        console.error(`[Gemini] API ${res.status}: ${errTxt}`);
        return { text: "Something went wrong reaching the AI. Try again in a moment.", costUsd: 0, error: `api_${res.status}: ${errTxt}` };
      }

      const data = await res.json() as { candidates?: Array<{ content?: { parts?: Part[] } }> };
      const parts = data.candidates?.[0]?.content?.parts || [];

      const textParts = parts
        .filter((p) => typeof (p as { text?: string }).text === "string")
        .map((p) => (p as { text: string }).text)
        .join("")
        .trim();
      if (textParts) finalText = textParts;

      const calls = parts.filter((p) => (p as { functionCall?: unknown }).functionCall) as Array<{ functionCall: { name: string; args?: Record<string, unknown> } }>;

      if (calls.length) {
        contents.push({ role: "model", parts });
        const responseParts: Part[] = [];
        for (const c of calls) {
          let result: string;
          try {
            result = await handleToolCall(c.functionCall.name, c.functionCall.args || {});
          } catch (e) {
            result = `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
          responseParts.push({ functionResponse: { name: c.functionCall.name, response: { result } } });
        }
        contents.push({ role: "user", parts: responseParts });
        continue;
      }

      return { text: finalText || "Done.", costUsd: 0 };
    }
    return { text: finalText || "That needed too many steps. Try narrowing the request.", costUsd: 0, error: "max_turns" };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[Gemini] error:", errMsg);
    return { text: "Something went wrong. Try again or rephrase your request.", costUsd: 0, error: errMsg };
  }
}
