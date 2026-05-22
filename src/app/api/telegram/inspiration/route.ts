// Webhook for the dedicated Inspiration bot (@flowinspirationbot).
// Receives shared URLs from Telegram, extracts metadata + Claude analysis,
// writes to the Notion Inspiration Library DB.
// Separate from /api/telegram (Flow Agent) and /api/telegram/compass (Coach).

export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { handleInspirationMessage } from "@/lib/inspiration/handler";
import type { TelegramMessage } from "@/lib/inspiration/types";

const INSPIRATION_WEBHOOK_SECRET = process.env.INSPIRATION_WEBHOOK_SECRET || "";
const INSPIRATION_BOT_TOKEN = process.env.INSPIRATION_BOT_TOKEN || "";

export async function POST(req: NextRequest) {
  console.log("[Inspiration] POST received");

  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (INSPIRATION_WEBHOOK_SECRET && secret !== INSPIRATION_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!INSPIRATION_BOT_TOKEN) {
    console.error("[Inspiration] INSPIRATION_BOT_TOKEN missing");
    return NextResponse.json(
      { error: "Inspiration bot token not configured" },
      { status: 500 },
    );
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message as TelegramMessage | undefined;
  if (!message) {
    return NextResponse.json({ ok: true });
  }

  try {
    await handleInspirationMessage(message, INSPIRATION_BOT_TOKEN);
  } catch (error) {
    console.error("[Inspiration] handler error:", error);
    const chatId = message.chat?.id;
    if (chatId) {
      try {
        const errText = error instanceof Error ? error.message : String(error);
        await fetch(
          `https://api.telegram.org/bot${INSPIRATION_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `Inspiration bot hit an error: ${errText.slice(0, 200)}`,
            }),
          },
        );
      } catch {
        console.error("[Inspiration] failed to send error notification");
      }
    }
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({
    status: "Flow Inspiration Bot is running",
    health: {
      bot_token: process.env.INSPIRATION_BOT_TOKEN ? "set" : "MISSING",
      notion_token: process.env.NOTION_TOKEN ? "set" : "MISSING",
      notion_db_id: process.env.NOTION_INSPIRATION_DB_ID ? "set" : "MISSING",
      anthropic_key: process.env.ANTHROPIC_API_KEY ? "set" : "MISSING",
      webhook_secret: process.env.INSPIRATION_WEBHOOK_SECRET ? "set" : "MISSING",
    },
  });
}
