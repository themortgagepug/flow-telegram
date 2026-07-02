#!/usr/bin/env node
// Long-polling bridge: replaces the cloudflared tunnel + Telegram webhook.
// Polls getUpdates and forwards each update to the local Next.js webhook
// route, so the bot needs NO public URL and survives DNS/tunnel failures.
//
// Safety: on startup it skips any backlog that accumulated while the bot
// was unreachable (stale commands must not fire actions hours later), and
// it only advances past an update after the local app accepted it (with a
// bounded retry so one poison update can't wedge the queue).
//
// Run under pm2: pm2 start scripts/poller.js --name flow-telegram-poller

const fs = require("fs");
const path = require("path");

// --- env from .env.local (pm2 doesn't load Next's env files) ---
const envPath = path.join(__dirname, "..", ".env.local");
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const SECRET = env.WEBHOOK_SECRET || "";
const LOCAL_URL = process.env.LOCAL_WEBHOOK_URL || "http://localhost:3000/api/telegram";
if (!TOKEN) { console.error("FATAL: TELEGRAM_BOT_TOKEN missing in .env.local"); process.exit(1); }

const API = `https://api.telegram.org/bot${TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method}: ${j.description || res.status}`);
  return j.result;
}

async function forward(update) {
  const res = await fetch(LOCAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify(update),
  });
  return res.ok;
}

async function main() {
  // getUpdates is forbidden while a webhook is registered. Keep pending
  // updates server-side; we deliberately skip them below anyway.
  await tg("deleteWebhook", { drop_pending_updates: false });
  console.log(`[poller] webhook cleared; forwarding to ${LOCAL_URL}`);

  // Skip backlog: fetch whatever is queued and jump past it without forwarding.
  let offset = 0;
  const backlog = await tg("getUpdates", { timeout: 0, limit: 100 });
  if (backlog.length > 0) {
    offset = backlog[backlog.length - 1].update_id + 1;
    console.log(`[poller] skipped ${backlog.length} stale update(s) from downtime`);
  }

  for (;;) {
    let updates;
    try {
      updates = await tg("getUpdates", {
        timeout: 50, offset, limit: 20, allowed_updates: ["message"],
      });
    } catch (e) {
      console.error(`[poller] getUpdates failed: ${e.message}; retrying in 5s`);
      await sleep(5000);
      continue;
    }

    for (const u of updates) {
      let delivered = false;
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        try {
          delivered = await forward(u);
        } catch { /* local app down or restarting */ }
        if (!delivered) await sleep(2000 * attempt);
      }
      if (!delivered) {
        console.error(`[poller] DROPPED update ${u.update_id} after 3 attempts`);
      } else {
        console.log(`[poller] delivered update ${u.update_id}`);
      }
      offset = u.update_id + 1;
    }
  }
}

main().catch((e) => { console.error(`[poller] fatal: ${e.message}`); process.exit(1); });
