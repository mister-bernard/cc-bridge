#!/bin/bash
# restart-cc-bridge.sh — safe restart wrapper for cc-bridge.service.
#
# ALWAYS use this instead of bare `systemctl --user restart cc-bridge`. It:
#   1. Validates .env is present and parseable
#   2. Backs up the current .env
#   3. Restarts via systemd
#   4. Waits and probes /health
#   5. Rolls .env back and restarts on failure
#
# Usage: bash deploy/restart-cc-bridge.sh "reason for restart"
#
# Environment overrides (optional):
#   CC_BRIDGE_DIR         path to your cc-bridge clone (default: $HOME/projects/cc-bridge)
#   CC_BRIDGE_UNIT        systemd unit name (default: cc-bridge.service)
#   CC_BRIDGE_HEALTH_URL  full health URL to probe (default: http://127.0.0.1:18901/health)
#   CC_BRIDGE_REQUIRED_VARS  whitespace-separated env keys that must appear
#                            in .env (default: CC_BRIDGE_PROVIDER_KEY)

set -uo pipefail

REASON="${1:-manual restart}"
UNIT="${CC_BRIDGE_UNIT:-cc-bridge.service}"
DIR="${CC_BRIDGE_DIR:-$HOME/projects/cc-bridge}"
ENV_FILE="$DIR/.env"
BACKUP="$ENV_FILE.bak.$(date +%s)"
HEALTH_URL="${CC_BRIDGE_HEALTH_URL:-http://127.0.0.1:18901/health}"
REQUIRED="${CC_BRIDGE_REQUIRED_VARS:-CC_BRIDGE_PROVIDER_KEY}"
LOG="${CC_BRIDGE_RESTART_LOG:-/tmp/cc-bridge-restart.log}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

log "cc-bridge restart requested: $REASON"

# 1. Env file must exist and be non-empty
if [ ! -s "$ENV_FILE" ]; then
  log "ABORT: $ENV_FILE missing or empty"
  exit 1
fi

# 2. Required vars present?
missing=""
for v in $REQUIRED; do
  if ! grep -q "^$v=" "$ENV_FILE"; then
    missing="$missing $v"
  fi
done
if [ -n "$missing" ]; then
  log "ABORT: .env is missing required vars:$missing"
  exit 1
fi

# 3. ANTHROPIC_API_KEY must NOT be set in .env (would break OAuth)
if grep -qE "^ANTHROPIC_API_KEY=.+" "$ENV_FILE"; then
  log "ABORT: ANTHROPIC_API_KEY is set in .env — Claude Code OAuth would be overridden"
  exit 1
fi

log ".env validated"

# 4. Backup env
cp "$ENV_FILE" "$BACKUP"
log "Env backed up to $BACKUP"

# 5. Restart
systemctl --user restart "$UNIT" 2>&1 | tee -a "$LOG"

# 6. Wait then probe /health
sleep 4
if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  log "cc-bridge healthy at $HEALTH_URL"
  # keep last 5 backups
  ls -t "$ENV_FILE".bak.* 2>/dev/null | tail -n +6 | xargs -r rm -f
  exit 0
fi

log "FAILED health probe ($HEALTH_URL) — rolling back .env"
cp "$BACKUP" "$ENV_FILE"
systemctl --user restart "$UNIT" 2>&1 | tee -a "$LOG"
sleep 4
if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  log "Rollback successful — bridge running with previous .env"
  exit 1
fi
log "CRITICAL: bridge won't come up even after rollback — manual intervention required"
log "  systemctl --user status $UNIT"
log "  journalctl --user -u $UNIT -n 200 --no-pager"
exit 2
