export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { handleMessage } from "@/lib/bot";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

export async function POST(req: NextRequest) {
  // Verify webhook secret (skip if not set)
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!TELEGRAM_BOT_TOKEN) {
    console.error("[Route] TELEGRAM_BOT_TOKEN is empty!");
    return NextResponse.json({ error: "Bot token not configured" }, { status: 500 });
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message as Record<string, unknown> | undefined;
  if (!message) return NextResponse.json({ ok: true });

  const chatId = (message.chat as Record<string, unknown>)?.id as number;

  // Return 200 immediately so Telegram doesn't timeout
  // Process in background via after()
  after(async () => {
    try {
      await handleMessage(message as Parameters<typeof handleMessage>[0], TELEGRAM_BOT_TOKEN);
    } catch (error) {
      console.error("[Route] Message handler error:", error);
      if (chatId && TELEGRAM_BOT_TOKEN) {
        try {
          const errText = error instanceof Error ? error.message : String(error);
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `Error: ${errText.slice(0, 200)}\n\nTry again or rephrase.`,
            }),
          });
        } catch {
          console.error("[Route] Failed to send error notification");
        }
      }
    }
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasZoho = !!process.env.ZOHO_REFRESH_TOKEN;

  return NextResponse.json({
    status: "Flow Agent Bot is running",
    version: "2.2",
    agents: ["property", "cx", "rates", "pipeline", "content", "general"],
    tools: 20,
    health: {
      telegram_token: hasToken ? "set" : "MISSING",
      anthropic_key: hasAnthropic ? "set" : "MISSING",
      zoho_credentials: hasZoho ? "set" : "MISSING",
    },
  });
}
