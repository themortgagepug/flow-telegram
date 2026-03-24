export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { handleMessage } from "@/lib/bot";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

export async function POST(req: NextRequest) {
  // Verify webhook secret
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message as Record<string, unknown> | undefined;
  if (!message) return NextResponse.json({ ok: true });

  // Respond 200 immediately so Telegram doesn't retry
  // Process the message in the background via after()
  after(async () => {
    try {
      await handleMessage(message as Parameters<typeof handleMessage>[0], TELEGRAM_BOT_TOKEN);
    } catch (error) {
      console.error("Message handler error:", error);
      // Try to send error message to user
      try {
        const chatId = (message.chat as Record<string, unknown>)?.id as number;
        if (chatId) {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: "Something went wrong processing your message. Try again or rephrase your request.",
            }),
          });
        }
      } catch {
        // Last resort -- can't even send error message
        console.error("Failed to send error notification");
      }
    }
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({
    status: "Flow Agent Bot is running",
    version: "2.0",
    agents: ["property", "cx", "rates", "pipeline", "content", "general"],
    tools: 11,
  });
}
