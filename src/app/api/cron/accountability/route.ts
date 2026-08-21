export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sendMessage } from "@/lib/telegram";
import { getAccountabilityMessage } from "@/lib/accountability";

const ALEX_CHAT_ID = Number(process.env.ALEX_CHAT_ID || "0");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ALEX_CHAT_ID || !TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  // Same rule as the morning briefing: nothing pushes to Telegram unsolicited.
  // This route was never deployed; its schedule was added to vercel.json in the
  // working tree and is now removed before it could ship.
  if ((process.env.FLOW_ALERTS_TELEGRAM || "off").toLowerCase() !== "on") {
    return NextResponse.json({ ok: true, sent: false, reason: "outbound_telegram_disabled" });
  }
  try {
    const text = await getAccountabilityMessage();
    await sendMessage(TELEGRAM_BOT_TOKEN, ALEX_CHAT_ID, text);
    return NextResponse.json({ ok: true, sent: true });
  } catch (error) {
    try {
      await sendMessage(
        TELEGRAM_BOT_TOKEN,
        ALEX_CHAT_ID,
        `Weekly accountability failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    } catch {}
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
