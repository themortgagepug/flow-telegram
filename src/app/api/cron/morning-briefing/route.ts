export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { handleToolCall } from "@/lib/tool-handlers";
import { sendMessage } from "@/lib/telegram";

// Alex's Telegram chat ID -- set via env var
const ALEX_CHAT_ID = Number(process.env.ALEX_CHAT_ID || "0");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!ALEX_CHAT_ID || !TELEGRAM_BOT_TOKEN) {
    console.error("[Cron] Missing ALEX_CHAT_ID or TELEGRAM_BOT_TOKEN");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  // No unsolicited Telegram. Alex, 2026-08-09: "I dont need any more
  // telegrams." FLOW_ALERTS_TELEGRAM=off was set that day in creds.env and
  // .env.local, and every shell sender honours it, but this app read the flag
  // nowhere, so this cron kept pushing a raw three-tool dump every weekday at
  // 07:00 PT for months. The schedule is now removed from vercel.json; this
  // guard is the second lock so re-adding a schedule alone cannot restart it.
  // The same content is still available on demand: send /briefing to the bot.
  if ((process.env.FLOW_ALERTS_TELEGRAM || "off").toLowerCase() !== "on") {
    return NextResponse.json({ ok: true, sent: false, reason: "outbound_telegram_disabled" });
  }

  try {
    // Fetch pipeline + revenue in parallel
    const [pipelineResult, revenueResult, partnerResult] = await Promise.all([
      handleToolCall("zoho_pipeline_report", {}),
      handleToolCall("revenue_dashboard", {}),
      handleToolCall("partner_intelligence", { mode: "cold_check" }),
    ]);

    const today = new Date().toLocaleDateString("en-CA", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/Los_Angeles",
    });

    const briefing = [
      `MORNING BRIEFING - ${today}`,
      ``,
      revenueResult,
      ``,
      `---`,
      ``,
      pipelineResult,
      ``,
      `---`,
      ``,
      partnerResult,
      ``,
      `What do you want to tackle first?`,
    ].join("\n");

    await sendMessage(TELEGRAM_BOT_TOKEN, ALEX_CHAT_ID, briefing);

    return NextResponse.json({ ok: true, sent: true });
  } catch (error) {
    console.error("[Cron] Morning briefing error:", error);

    // Try to send error notification
    try {
      await sendMessage(
        TELEGRAM_BOT_TOKEN,
        ALEX_CHAT_ID,
        `Morning briefing failed: ${error instanceof Error ? error.message : "Unknown error"}. Try /briefing manually.`
      );
    } catch {
      // Can't even notify
    }

    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
