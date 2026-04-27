#!/bin/bash
# Persistent Cloudflare Tunnel with auto-webhook registration
# Monitors tunnel health, restarts on failure, re-registers Telegram webhook

TOKEN="8740292610:AAEwpjWspc1lNUHKAa-ls9xYEHjX8Dj-Acs"
PORT=3000
LOG="/tmp/cloudflared-bot.log"

update_webhook() {
  local url="$1"
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${url}/api/telegram\",\"allowed_updates\":[\"message\"]}" > /dev/null
  echo "[$(date)] Webhook set: ${url}/api/telegram"
}

while true; do
  echo "[$(date)] Starting cloudflared tunnel..."
  rm -f "$LOG"
  cloudflared tunnel --url "http://localhost:${PORT}" > "$LOG" 2>&1 &
  CF_PID=$!

  # Wait for tunnel URL
  TUNNEL=""
  for i in $(seq 1 20); do
    TUNNEL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null | head -1)
    if [ -n "$TUNNEL" ]; then
      break
    fi
    sleep 1
  done

  if [ -n "$TUNNEL" ]; then
    echo "[$(date)] Tunnel live: $TUNNEL"
    update_webhook "$TUNNEL"

    # Health check loop — every 30s
    while kill -0 $CF_PID 2>/dev/null; do
      sleep 30
      HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${TUNNEL}/api/telegram" 2>/dev/null)
      if [ "$HTTP" != "200" ]; then
        echo "[$(date)] Tunnel unhealthy (HTTP $HTTP), restarting..."
        kill $CF_PID 2>/dev/null
        wait $CF_PID 2>/dev/null
        break
      fi
    done
  else
    echo "[$(date)] Failed to get tunnel URL, retrying in 5s..."
    kill $CF_PID 2>/dev/null
    wait $CF_PID 2>/dev/null
  fi

  sleep 5
done
