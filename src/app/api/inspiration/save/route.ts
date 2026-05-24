// HTTP API for the iOS Shortcut share-sheet path.
// POST {url, note?} with Bearer auth → saves to Notion Inspiration Library.
// Separate from the Telegram bot webhook so it returns a clean synchronous response.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { analyzeContent } from "@/lib/inspiration/claude";
import { extractMetadata, extractUrls } from "@/lib/inspiration/metadata";
import { writeToNotion } from "@/lib/inspiration/notion";
import type { InspirationItem } from "@/lib/inspiration/types";

const API_KEY = process.env.INSPIRATION_API_KEY || "";

export async function POST(req: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json(
      { ok: false, error: "INSPIRATION_API_KEY not configured" },
      { status: 500 },
    );
  }

  const auth = req.headers.get("authorization") || "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim();
  if (provided !== API_KEY) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { url?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const rawInput = typeof body.url === "string" ? body.url : "";
  const note = typeof body.note === "string" ? body.note.trim() : undefined;

  const urls = extractUrls(rawInput);
  const url = urls[0];

  if (!url) {
    return NextResponse.json(
      { ok: false, error: "No URL found in body.url" },
      { status: 400 },
    );
  }

  try {
    const meta = await extractMetadata(url);
    const analysis = await analyzeContent(meta, note);

    const item: InspirationItem = {
      ...meta,
      ...analysis,
      alex_caption: note,
      date_added_iso: new Date().toISOString(),
    };

    const write = await writeToNotion(item);

    if (!write.ok) {
      return NextResponse.json(
        { ok: false, error: write.error || "Notion write failed" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      notion_url: write.page_url,
      title: meta.title || meta.url,
      platform: meta.platform,
      creator: meta.creator_handle,
      tier: analysis.performance_tier_guess,
      tags: analysis.topic_tags,
      hook_framework: analysis.hook_framework,
      summary: analysis.notes_summary,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    status: "Inspiration Save API is running",
    method: "POST /api/inspiration/save",
    auth: "Bearer <INSPIRATION_API_KEY>",
    body: { url: "string (required)", note: "string (optional)" },
    health: {
      api_key: process.env.INSPIRATION_API_KEY ? "set" : "MISSING",
      notion_token: process.env.NOTION_TOKEN ? "set" : "MISSING",
      notion_db_id: process.env.NOTION_INSPIRATION_DB_ID ? "set" : "MISSING",
      anthropic_key: process.env.ANTHROPIC_API_KEY ? "set" : "MISSING",
    },
  });
}
