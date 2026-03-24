import { NextRequest, NextResponse } from "next/server";
import { handleMessage } from "@/lib/bot";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

export async function POST(req: NextRequest) {
  // Verify webhook secret if set
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const update = await req.json();

    // Handle text messages
    if (update.message?.text) {
      await handleMessage(update.message, TELEGRAM_BOT_TOKEN);
    }

    // Handle photo messages (for document intake)
    if (update.message?.photo) {
      await handleMessage(
        { ...update.message, text: update.message.caption || "/upload" },
        TELEGRAM_BOT_TOKEN
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json({ ok: true }); // Always 200 so Telegram doesn't retry
  }
}

export async function GET() {
  return NextResponse.json({
    status: "Flow Agent Bot is running",
    agents: ["property", "cx", "rates", "pipeline", "content", "general"],
  });
}
