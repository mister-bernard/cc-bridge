#!/usr/bin/env bash
# tg-send.sh — send a Telegram message from inside a cc-bridge session.
#
# Thin wrapper that delegates to a canonical sender (e.g. telegraph's
# `tg-send-logged.sh`). Delegating keeps a single source of truth for outbox
# logging AND origin registration — so a user's reply to a session-spawned
# message routes back to this session, not to a static fallback.
#
# Configuration (from environment, typically loaded via the systemd
# EnvironmentFile from `.env`):
#   CC_BRIDGE_TG_SEND_CANONICAL  Path to the canonical sender. Required for
#                                outbox + origin tracking.
#   CC_BRIDGE_TG_SEND_FALLBACK   Optional second path, tried if CANONICAL
#                                isn't executable. Lets operators stage a
#                                migration without breaking sessions.
#   CC_BRIDGE_TG_DEFAULT_CHAT    Default target chat (Telegram user/chat
#                                ID). Override per-call with `--chat <id>`.
#   SESSION_ID                   Sender label used by the canonical sender
#                                for outbox logging. Set by the daemon
#                                when it spawns a session.
#
# Usage:
#   tg-send.sh "message text"
#   echo "message text" | tg-send.sh         (stdin mode)
#   tg-send.sh --silent "message"            (disable_notification — depends on canonical)
#   tg-send.sh --chat <id> "message"         (override target chat)

set -euo pipefail

CANONICAL="${CC_BRIDGE_TG_SEND_CANONICAL:-}"
FALLBACK="${CC_BRIDGE_TG_SEND_FALLBACK:-}"
SENDER="${SESSION_ID:-cc-bridge}"
CHAT_ID="${CC_BRIDGE_TG_DEFAULT_CHAT:-${TG_CHAT_ID:-}}"
SILENT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --silent) SILENT=true; shift ;;
    --chat)   CHAT_ID="$2"; shift 2 ;;
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

if [[ -z "$CHAT_ID" ]]; then
  echo "tg-send.sh: no chat id (set CC_BRIDGE_TG_DEFAULT_CHAT or pass --chat)" >&2
  exit 1
fi

if [[ "$SILENT" == "true" ]]; then
  echo "tg-send.sh: --silent passthrough depends on canonical sender" >&2
fi

if [[ -n "$CANONICAL" && -x "$CANONICAL" ]]; then
  TARGET="$CANONICAL"
elif [[ -n "$FALLBACK" && -x "$FALLBACK" ]]; then
  TARGET="$FALLBACK"
else
  echo "tg-send.sh: no canonical sender found" >&2
  echo "  set CC_BRIDGE_TG_SEND_CANONICAL to an executable telegram sender" >&2
  echo "  (e.g. telegraph/scripts/tg-send-logged.sh)" >&2
  exit 1
fi

exec "$TARGET" "$CHAT_ID" "$SENDER" "$MSG"
