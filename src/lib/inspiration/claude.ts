import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeAnalysis, ExtractedMetadata } from "./types";

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You analyze short-form content saved to an Inspiration Library for a Canadian mortgage broker (@themortgagepug, real name Alex McFadyen) who builds content about mortgages, real estate, wealth, operator/business, and life philosophy.

You extract structured tags from a single piece of content. Return JSON ONLY, no prose, matching this schema exactly:

{
  "topic_tags": string[],          // 2-5 tags from: ["mortgages","real-estate","wealth","operator","life","contrarian","data-driven","story","rant","explainer","hook-format","framework","other"]
  "hook_framework": string|null,   // one of: "contrarian-thesis","data-shock","callout","problem-agitation","numbered-list","reframe","story-open","tease","question","stat-stack","challenge","other"
  "hook_text": string|null,        // the actual opening line/words from the content if extractable, else null
  "notes_summary": string,         // 1-2 sentence summary of WHY this is worth saving as inspiration (the pattern/format/idea worth stealing)
  "performance_tier_guess": "S"|"A"|"B"|"C"|null  // S=likely viral, A=strong, B=avg, C=weak. Null if not enough signal.
}

Be terse. No marketing fluff. No em-dashes. Match the cynical operator voice.`;

export async function analyzeContent(
  meta: ExtractedMetadata,
  alexCaption?: string,
): Promise<ClaudeAnalysis> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return fallbackAnalysis(meta, alexCaption);
  }

  const client = new Anthropic({ apiKey });

  const userContent = [
    `URL: ${meta.url}`,
    `Platform: ${meta.platform}`,
    meta.creator_handle ? `Creator: @${meta.creator_handle}` : null,
    meta.title ? `Title: ${meta.title}` : null,
    meta.description ? `Caption/Description: ${meta.description}` : null,
    meta.duration_seconds ? `Duration: ${meta.duration_seconds}s` : null,
    alexCaption ? `Alex's note when saving: ${alexCaption}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return parseJson(text) ?? fallbackAnalysis(meta, alexCaption);
  } catch (err) {
    console.error("[Inspiration] Claude analyze failed:", err);
    return fallbackAnalysis(meta, alexCaption);
  }
}

function parseJson(text: string): ClaudeAnalysis | null {
  const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const tags = Array.isArray(parsed.topic_tags)
      ? parsed.topic_tags.filter((t): t is string => typeof t === "string").slice(0, 5)
      : [];

    return {
      topic_tags: tags.length ? tags : ["other"],
      hook_framework:
        typeof parsed.hook_framework === "string" ? parsed.hook_framework : undefined,
      hook_text: typeof parsed.hook_text === "string" ? parsed.hook_text : undefined,
      notes_summary:
        typeof parsed.notes_summary === "string"
          ? parsed.notes_summary
          : "Saved without analysis.",
      performance_tier_guess:
        parsed.performance_tier_guess === "S" ||
        parsed.performance_tier_guess === "A" ||
        parsed.performance_tier_guess === "B" ||
        parsed.performance_tier_guess === "C"
          ? parsed.performance_tier_guess
          : undefined,
    };
  } catch {
    return null;
  }
}

function fallbackAnalysis(meta: ExtractedMetadata, alexCaption?: string): ClaudeAnalysis {
  return {
    topic_tags: ["other"],
    notes_summary:
      alexCaption ??
      meta.description?.slice(0, 200) ??
      `Saved from ${meta.platform}. No automated analysis available.`,
  };
}
