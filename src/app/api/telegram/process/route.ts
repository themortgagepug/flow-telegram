export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { handleMessage } from "@/lib/bot";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const INTERNAL_SECRET = TELEGRAM_BOT_TOKEN || "internal";

export async function POST(req: NextRequest) {
  // Only accept calls from our own webhook route
  const secret = req.headers.get("x-internal-secret");
  if (secret !== INTERNAL_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { message: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = body.message;
  if (!message) return NextResponse.json({ ok: true });

  const chatId = (message.chat as Record<string, unknown>)?.id as number;

  try {
    await handleMessage(message as Parameters<typeof handleMessage>[0], TELEGRAM_BOT_TOKEN);
  } catch (error) {
    console.error("[Process] Message handler error:", error);
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
        console.error("[Process] Failed to send error notification");
      }
    }
  }

  return NextResponse.json({ ok: true });
}
