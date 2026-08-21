export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { handleMessage } from "@/lib/bot";

// Team bot (@flowmortgagecoteambot) -- separate token + scoped toolset from the main Flow Agent bot.
const WEBHOOK_SECRET = process.env.TEAM_WEBHOOK_SECRET || "";
const TEAM_BOT_TOKEN = process.env.TEAM_BOT_TOKEN || "";

export async function POST(req: NextRequest) {
  console.log("[TeamRoute] POST received");

  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!TEAM_BOT_TOKEN) {
    console.error("[TeamRoute] TEAM_BOT_TOKEN is empty!");
    return NextResponse.json({ error: "Team bot token not configured" }, { status: 500 });
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

  const chatId = (message.chat as Record<string, unknown>)?.id as number;
  console.log(`[TeamRoute] Processing message from chat ${chatId}`);

  try {
    await handleMessage(message as Parameters<typeof handleMessage>[0], TEAM_BOT_TOKEN, { teamBot: true });
    console.log("[TeamRoute] handleMessage completed");
  } catch (error) {
    console.error("[TeamRoute] Message handler error:", error);
    if (chatId && TEAM_BOT_TOKEN) {
      try {
        const errText = error instanceof Error ? error.message : String(error);
        await fetch(`https://api.telegram.org/bot${TEAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `Error: ${errText.slice(0, 200)}\n\nTry again or rephrase.`,
          }),
        });
      } catch {
        console.error("[TeamRoute] Failed to send error notification");
      }
    }
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({
    status: "Flow Team IQ bot is running",
    bot: "@flowmortgagecoteambot",
    scoped: true,
    team_token_present: !!process.env.TEAM_BOT_TOKEN,
  });
}
