#!/usr/bin/env bash
# Sets up the Telegram webhook to point to your Vercel deployment
# Usage: ./scripts/setup-webhook.sh <BOT_TOKEN> <VERCEL_URL>

set -euo pipefail

TOKEN="${1:?Usage: setup-webhook.sh <BOT_TOKEN> <VERCEL_URL>}"
URL="${2:?Usage: setup-webhook.sh <BOT_TOKEN> <VERCEL_URL>}"
SECRET="flow-telegram-2026"

echo "Setting webhook..."
curl -sf "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -d "url=${URL}/api/telegram" \
  -d "secret_token=${SECRET}" \
  -d "allowed_updates=[\"message\"]"

echo ""
echo ""
echo "Verifying..."
curl -sf "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -m json.tool

echo ""
echo "Done! Bot is now listening at ${URL}/api/telegram"
