import { sendMessage, sendTypingAction } from "@/lib/telegram";
import { analyzeContent } from "./claude";
import { extractMetadata, extractUrls } from "./metadata";
import { writeToNotion } from "./notion";
import type { InspirationItem, TelegramMessage } from "./types";

export async function handleInspirationMessage(
  message: TelegramMessage,
  botToken: string,
): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text || message.caption || "";

  if (!text.trim()) {
    await sendMessage(
      botToken,
      chatId,
      "Share a link from Instagram, TikTok, YouTube, or X to save it to the Inspiration Library.\n\nYou can add a note after the link — I'll attach it to the save.",
    );
    return;
  }

  const trimmed = text.trim();
  if (trimmed === "/start" || trimmed === "/help") {
    await sendMessage(
      botToken,
      chatId,
      [
        "<b>Flow Inspiration Bot</b>",
        "",
        "Send me any short-form content URL and I'll save it to your Notion Inspiration Library with Claude-extracted tags.",
        "",
        "<b>Supported:</b>",
        "• Instagram reels / posts",
        "• TikTok videos",
        "• YouTube videos / Shorts",
        "• X (Twitter) posts",
        "",
        "<b>Tip:</b> Add a short note after the URL and I'll include it in the save.",
      ].join("\n"),
    );
    return;
  }

  const urls = extractUrls(text);
  if (urls.length === 0) {
    await sendMessage(
      botToken,
      chatId,
      "No URL found in that message. Paste an Instagram, TikTok, YouTube, or X link.",
    );
    return;
  }

  await sendTypingAction(botToken, chatId);

  const alexCaption = stripUrls(text).trim() || undefined;
  const results: Array<{ url: string; status: "ok" | "fail"; detail: string }> = [];

  for (const url of urls.slice(0, 5)) {
    try {
      const meta = await extractMetadata(url);
      const analysis = await analyzeContent(meta, alexCaption);

      const item: InspirationItem = {
        ...meta,
        ...analysis,
        alex_caption: alexCaption,
        date_added_iso: new Date().toISOString(),
      };

      const write = await writeToNotion(item);

      if (write.ok) {
        const tagStr = analysis.topic_tags.slice(0, 3).join(", ");
        const tierStr = analysis.performance_tier_guess
          ? ` · Tier ${analysis.performance_tier_guess}`
          : "";
        const detail = [
          `<b>${capitalize(meta.platform)}</b>${meta.creator_handle ? ` · @${escapeHtml(meta.creator_handle)}` : ""}${tierStr}`,
          tagStr ? `tags: ${escapeHtml(tagStr)}` : "",
          analysis.notes_summary ? escapeHtml(analysis.notes_summary) : "",
          write.page_url ? `<a href="${write.page_url}">Open in Notion</a>` : "",
        ]
          .filter(Boolean)
          .join("\n");
        results.push({ url, status: "ok", detail });
      } else {
        results.push({
          url,
          status: "fail",
          detail: `Notion write failed: ${escapeHtml(write.error || "unknown error")}`,
        });
      }
    } catch (err) {
      results.push({
        url,
        status: "fail",
        detail: `Error: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
      });
    }
  }

  const summary = results
    .map((r, i) => {
      const head = r.status === "ok" ? "Saved" : "Failed";
      return `<b>${head} ${i + 1}/${results.length}</b>\n${r.detail}`;
    })
    .join("\n\n");

  await sendMessage(botToken, chatId, summary);
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/gi, "").trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
