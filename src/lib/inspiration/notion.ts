import type { InspirationItem } from "./types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionWriteResult {
  ok: boolean;
  page_id?: string;
  page_url?: string;
  error?: string;
}

export async function writeToNotion(item: InspirationItem): Promise<NotionWriteResult> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_INSPIRATION_DB_ID;

  if (!token || !dbId) {
    return {
      ok: false,
      error: `Missing env: ${!token ? "NOTION_TOKEN " : ""}${!dbId ? "NOTION_INSPIRATION_DB_ID" : ""}`.trim(),
    };
  }

  const title =
    item.title?.slice(0, 100) ||
    item.hook_text?.slice(0, 100) ||
    item.notes_summary.slice(0, 100) ||
    `${item.platform} save ${item.date_added_iso.slice(0, 10)}`;

  const properties: Record<string, unknown> = {
    Title: { title: [{ text: { content: title } }] },
    Platform: { select: { name: capitalize(item.platform) } },
    "Source URL": { url: item.url },
    "Date Added": { date: { start: item.date_added_iso } },
    Type: { select: { name: typeForPlatform(item.platform) } },
  };

  if (item.creator_handle) {
    properties["Creator Handle"] = {
      rich_text: [{ text: { content: item.creator_handle.slice(0, 100) } }],
    };
  }

  if (item.topic_tags.length) {
    properties["Topic Tags"] = {
      multi_select: item.topic_tags.slice(0, 5).map((t) => ({ name: t })),
    };
  }

  if (item.hook_framework) {
    properties["Hook Framework"] = { select: { name: item.hook_framework } };
  }

  if (item.hook_text) {
    properties["Hook Text"] = {
      rich_text: [{ text: { content: item.hook_text.slice(0, 1900) } }],
    };
  }

  if (item.performance_tier_guess) {
    properties["Performance Tier"] = { select: { name: item.performance_tier_guess } };
  }

  const notesParts = [
    item.notes_summary,
    item.alex_caption ? `\n\nAlex's note: ${item.alex_caption}` : "",
    item.description ? `\n\nOriginal caption: ${item.description.slice(0, 500)}` : "",
    `\n\nFetched via: ${item.fetched_via}`,
  ];
  properties.Notes = {
    rich_text: [{ text: { content: notesParts.join("").slice(0, 1900) } }],
  };

  properties.Source = {
    rich_text: [{ text: { content: "Telegram share-to-save" } }],
  };

  try {
    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `Notion ${res.status}: ${errText.slice(0, 300)}` };
    }

    const data = (await res.json()) as { id?: string; url?: string };
    return { ok: true, page_id: data.id, page_url: data.url };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function typeForPlatform(p: string): string {
  if (p === "instagram" || p === "tiktok") return "Reel";
  if (p === "youtube") return "Video";
  if (p === "twitter") return "Tweet";
  return "Other";
}
