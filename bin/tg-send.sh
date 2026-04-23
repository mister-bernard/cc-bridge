#!/usr/bin/env bash
# tg-send.sh — send a message to G's Telegram from inside a cc-bridge session.
#
# Thin wrapper around the canonical sender at
# telegraph/scripts/tg-send-logged.sh. Delegating keeps a single source of
# truth for outbox logging AND origin registration (so G's reply to a
# session-spawned message routes back to this session, not the static table).
#
# Usage:
#   tg-send.sh "message text"
#   echo "message text" | tg-send.sh         (stdin mode)
#   tg-send.sh --silent "message"            (disable_notification=true — ignored for now)
#   tg-send.sh --chat <id> "message"         (override target chat)

set -euo pipefail

CANONICAL="/home/openclaw/projects/telegraph/scripts/tg-send-logged.sh"
COMPAT_LINK="/home/openclaw/scripts/tg-send-logged.sh"
SENDER="${SESSION_ID:-cc-bridge}"
G_CHAT_ID="${TG_CHAT_ID:-39172309}"
SILENT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --silent) SILENT=true; shift ;;
    --chat)   G_CHAT_ID="$2"; shift 2 ;;
    *) break ;;
  esac
done

if [[ $# -gt 0 ]]; then
  MSG="$*"
else
  MSG=$(cat)
fi

if [[ -z "$MSG" ]]; then
  echo "usage: tg-send.sh [--silent] [--chat ID] \"message\"" >&2
  exit 1
fi

# --silent currently unsupported by tg-send-logged.sh; log and continue.
if [[ "$SILENT" == "true" ]]; then
  echo "tg-send.sh: --silent ignored (not supported by canonical sender)" >&2
fi

if [[ -x "$CANONICAL" ]]; then
  TARGET="$CANONICAL"
elif [[ -x "$COMPAT_LINK" ]]; then
  TARGET="$COMPAT_LINK"
else
  echo "tg-send.sh: canonical sender not found at $CANONICAL or $COMPAT_LINK" >&2
  exit 1
fi

exec "$TARGET" "$G_CHAT_ID" "$SENDER" "$MSG"
