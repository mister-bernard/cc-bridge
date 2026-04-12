#!/usr/bin/env bash
# kill-cc-bridge.sh — EMERGENCY rollback for cc-telegram-bridge.
#
# Stops the bridge daemon, restores the last-pre-cc-bridge openclaw.json
# backup, and restarts the gateway so Telegram + Signal DMs from G go back
# through the pre-existing agents (opus-dm for TG, opus-dm for Signal).
#
# Use this if:
#   - cc-bridge starts doing something wrong on a live DM
#   - the persistent CC session gets stuck or leaks state
#   - you need to quickly undo everything while you debug
#
# Usage:
#   bash kill-cc-bridge.sh [reason]

set -euo pipefail

REASON="${1:-emergency rollback}"
BACKUP_DIR="$HOME/.openclaw/config-backups"

# Find the most recent pre-cc-bridge backup.
BACKUP=$(ls -t "$BACKUP_DIR"/openclaw.json.pre-cc-bridge-* 2>/dev/null | head -1)
if [[ -z "$BACKUP" ]]; then
  echo "ERROR: no pre-cc-bridge backup found in $BACKUP_DIR" >&2
  echo "You'll need to remove the cc-bridge provider/agents/bindings by hand." >&2
  exit 1
fi

echo "[kill] Reason: $REASON"
echo "[kill] Restoring config from: $BACKUP"

# 1) stop bridge
systemctl --user stop cc-telegram-bridge 2>/dev/null || true
systemctl --user disable cc-telegram-bridge 2>/dev/null || true

# 2) restore config
cp "$HOME/.openclaw/openclaw.json" "$HOME/.openclaw/openclaw.json.rolled-back-$(date +%s)"
cp "$BACKUP" "$HOME/.openclaw/openclaw.json"

# 3) restart gateway via safe wrapper (has its own rollback-on-failure)
bash "$HOME/.openclaw/workspace.old/scripts/restart-gateway.sh" "kill-cc-bridge: $REASON"

echo "[kill] DONE. cc-bridge stopped, config restored, gateway restarted."
echo "[kill] To re-enable later:"
echo "  bash /home/openclaw/projects/cc-telegram-bridge/scripts/apply-config-edits.py"
echo "  bash /home/openclaw/projects/cc-telegram-bridge/scripts/apply-config-edits-v2.py"
echo "  systemctl --user enable --now cc-telegram-bridge"
echo "  bash $HOME/.openclaw/workspace.old/scripts/restart-gateway.sh 're-enable cc-bridge'"
