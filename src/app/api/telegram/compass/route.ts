// Webhook for the dedicated Coach bot (@flowmortgagecoachbot).
// Separate from /api/telegram which serves the ops Flow Agent bot.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { handleCompassMessage } from "@/lib/compass/handler";

const COMPASS_WEBHOOK_SECRET = process.env.COMPASS_WEBHOOK_SECRET || "";
const COMPASS_TELEGRAM_BOT_TOKEN = process.env.COMPASS_TELEGRAM_BOT_TOKEN || "";

export async function POST(req: NextRequest) {
  console.log("[Compass] POST received");

  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (COMPASS_WEBHOOK_SECRET && secret !== COMPASS_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!COMPASS_TELEGRAM_BOT_TOKEN) {
    console.error("[Compass] COMPASS_TELEGRAM_BOT_TOKEN missing");
    return NextResponse.json(
      { error: "Coach bot token not configured" },
      { status: 500 },
    );
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message as Record<string, unknown> | undefined;
  if (!message) {
    return NextResponse.json({ ok: true });
  }

  try {
    await handleCompassMessage(
      message as unknown as Parameters<typeof handleCompassMessage>[0],
      COMPASS_TELEGRAM_BOT_TOKEN,
    );
  } catch (error) {
    console.error("[Compass] handler error:", error);
    const chatId = (message.chat as Record<string, unknown>)?.id as number;
    if (chatId) {
      try {
        const errText = error instanceof Error ? error.message : String(error);
        await fetch(
          `https://api.telegram.org/bot${COMPASS_TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `Coach hit an error: ${errText.slice(0, 200)}\n\nTry again.`,
            }),
          },
        );
      } catch {
        console.error("[Compass] error notify failed");
      }
    }
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({
    status: "Coach bot webhook running",
    bot: "@flowmortgagecoachbot",
    health: {
      compass_token: COMPASS_TELEGRAM_BOT_TOKEN ? "set" : "MISSING",
      anthropic_key: process.env.ANTHROPIC_API_KEY ? "set" : "MISSING",
      service_key: process.env.SUPABASE_SERVICE_KEY ? "set" : "MISSING",
    },
  });
}
