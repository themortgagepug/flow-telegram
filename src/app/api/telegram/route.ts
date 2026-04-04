export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const INTERNAL_SECRET = process.env.TELEGRAM_BOT_TOKEN || "internal";

export async function POST(req: NextRequest) {
  // Verify webhook secret (skip if not set)
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
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

  // Fire-and-forget to the process endpoint (separate invocation with its own 60s)
  const host = req.headers.get("host") || "flow-telegram-pi.vercel.app";
  const protocol = host.includes("localhost") ? "http" : "https";
  fetch(`${protocol}://${host}/api/telegram/process`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": INTERNAL_SECRET,
    },
    body: JSON.stringify({ message }),
  }).catch((err) => console.error("[Route] Failed to dispatch to process:", err));

  // Return 200 immediately so Telegram doesn't timeout
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
