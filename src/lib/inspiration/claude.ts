import Anthropic from "@anthropic-ai/sdk";
import type {
  ClaudeAnalysis,
  ExtractedMetadata,
  HookFramework,
  PerformanceTier,
} from "./types";

const MODEL = "claude-haiku-4-5-20251001";

const VALID_FRAMEWORKS: readonly HookFramework[] = [
  "Curiosity Gap",
  "Proof-First",
  "Pain Point",
  "Contrarian",
  "This Cost Me Thousands",
  "Unexpected Confession",
  "Question Hook",
  "Pattern Interrupt",
  "Before vs After",
  "Test / Experiment",
] as const;

const VALID_TIERS: readonly PerformanceTier[] = [
  "Outlier",
  "Strong",
  "Reference",
  "Untested",
] as const;

const SYSTEM_PROMPT = `You analyze short-form content saved to an Inspiration Library for a Canadian mortgage broker (@themortgagepug, real name Alex McFadyen) who builds content about mortgages, real estate, wealth, operator/business, and life philosophy.

You extract structured tags from a single piece of content. Return JSON ONLY, no prose, matching this schema exactly:

{
  "topic_tags": string[],          // 2-5 freeform short tags (e.g. "rates","renewals","contrarian","data","story","FTHB","investor","rant","explainer")
  "hook_framework": string|null,   // EXACTLY ONE of: "Curiosity Gap","Proof-First","Pain Point","Contrarian","This Cost Me Thousands","Unexpected Confession","Question Hook","Pattern Interrupt","Before vs After","Test / Experiment" — or null if unclear
  "hook_text": string|null,        // the actual opening line/words from the content if extractable, else null
  "notes_summary": string,         // 1-2 sentence summary of WHY this is worth saving as inspiration (the pattern/format/idea worth stealing)
  "performance_tier_guess": "Outlier"|"Strong"|"Reference"|"Untested"  // Outlier = likely viral, Strong = solid, Reference = decent format reference, Untested = not enough signal
}

Be terse. No marketing fluff. No em-dashes. Match the cynical operator voice. The hook_framework value MUST match one of the listed options character-for-character including capitalization and spacing — return null if none fit.`;

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

    const fw =
      typeof parsed.hook_framework === "string" &&
      (VALID_FRAMEWORKS as readonly string[]).includes(parsed.hook_framework)
        ? (parsed.hook_framework as HookFramework)
        : undefined;

    const tier =
      typeof parsed.performance_tier_guess === "string" &&
      (VALID_TIERS as readonly string[]).includes(parsed.performance_tier_guess)
        ? (parsed.performance_tier_guess as PerformanceTier)
        : "Untested";

    return {
      topic_tags: tags.length ? tags : ["other"],
      hook_framework: fw,
      hook_text: typeof parsed.hook_text === "string" ? parsed.hook_text : undefined,
      notes_summary:
        typeof parsed.notes_summary === "string"
          ? parsed.notes_summary
          : "Saved without analysis.",
      performance_tier_guess: tier,
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
    performance_tier_guess: "Untested",
  };
}
