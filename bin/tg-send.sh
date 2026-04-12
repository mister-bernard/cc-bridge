#!/usr/bin/env bash
# tg-send.sh — send a message to G's Telegram from inside a cc-bridge session.
#
# This script gives CC the ability to PROACTIVELY message G without being
# asked first. CC calls it via Bash tool:
#   bash ~/projects/cc-bridge/bin/tg-send.sh "hey G, finished the analysis"
#
# It reads the bot token from the bridge .env file. Messages are chunked
# at 4000 chars to stay within Telegram's 4096 limit.
#
# Usage:
#   tg-send.sh "message text"
#   echo "message text" | tg-send.sh    (stdin mode)
#   tg-send.sh --silent "message"       (disable_notification=true)

set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
G_CHAT_ID="${TG_CHAT_ID:-39172309}"
SILENT=false

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --silent) SILENT=true; shift ;;
    --chat) G_CHAT_ID="$2"; shift 2 ;;
    *) break ;;
  esac
done

# Get the message — from args or stdin
if [[ $# -gt 0 ]]; then
  MSG="$*"
else
  MSG=$(cat)
fi

if [[ -z "$MSG" ]]; then
  echo "usage: tg-send.sh [--silent] [--chat ID] \"message\"" >&2
  exit 1
fi

# Read bot token from bridge .env
TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [[ -z "$TG_TOKEN" ]]; then
  TG_TOKEN=$(python3 -c "
import re
for line in open('${BRIDGE_DIR}/.env'):
    m = re.match(r'^TELEGRAM_BOT_TOKEN=(.*)$', line.rstrip())
    if m: print(m.group(1)); break
" 2>/dev/null || true)
fi
if [[ -z "$TG_TOKEN" ]]; then
  TG_TOKEN=$(python3 -c "
import re
for line in open('/home/openclaw/.openclaw/.env'):
    m = re.match(r'^TELEGRAM_BOT_TOKEN=(.*)$', line.rstrip())
    if m: print(m.group(1)); break
" 2>/dev/null || true)
fi

if [[ -z "$TG_TOKEN" ]]; then
  echo "error: no TELEGRAM_BOT_TOKEN found" >&2
  exit 1
fi

# Send in chunks of 4000 chars
len=${#MSG}
i=0
while [[ $i -lt $len ]]; do
  chunk="${MSG:$i:4000}"
  ARGS=(-d "chat_id=$G_CHAT_ID" --data-urlencode "text=$chunk")
  if [[ "$SILENT" == "true" ]]; then
    ARGS+=(-d "disable_notification=true")
  fi
  curl -sS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    "${ARGS[@]}" > /dev/null
  i=$((i + 4000))
done
