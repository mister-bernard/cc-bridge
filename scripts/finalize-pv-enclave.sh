#!/usr/bin/env bash
# finalize-pv-enclave.sh — one-shot wiring for the @pvenclavebot once G has
# created it in BotFather and has the bot token.
#
# What this does:
#   1. Stores the token in the vault as "Bots/PV Enclave Telegram Bot".
#   2. Adds `channels.telegram.accounts.pv-enclave` to ~/.openclaw/openclaw.json
#      with dmPolicy=allowlist, allowFrom=["39172309"] (G only).
#   3. Prepends a binding: telegram dm 39172309 on account=pv-enclave → cc-bridge-pv
#   4. Restarts the gateway via the safe wrapper.
#
# Usage:
#   bash finalize-pv-enclave.sh '<bot-token-from-botfather>'

set -euo pipefail

TOKEN="${1:-}"
if [[ -z "$TOKEN" ]]; then
  echo "Usage: $0 <bot-token-from-botfather>" >&2
  echo "  Get the token from @BotFather:" >&2
  echo "  1. Open @BotFather in Telegram (as G)" >&2
  echo "  2. /newbot   (name: PV Enclave, username: pvenclavebot)" >&2
  echo "  3. Copy the token it gives you" >&2
  echo "  4. Run: $0 '<token>'" >&2
  exit 1
fi

# Basic shape check: Telegram tokens look like NNNNNNNNN:<35+ chars>
if [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
  echo "ERROR: token doesn't look like a Telegram bot token (expected NNN:xxx...)" >&2
  exit 1
fi

echo "[finalize] vault: adding Bots/PV Enclave Telegram Bot..."
VAULT_MASTER_PASSWORD=$(python3 -c "
import re
for line in open('/home/openclaw/.openclaw/.env'):
    m = re.match(r'^VAULT_MASTER_PASSWORD=(.*)$', line.rstrip())
    if m: print(m.group(1)); break
")
printf '%s\n%s\n' "$VAULT_MASTER_PASSWORD" "$TOKEN" | keepassxc-cli add --password-prompt --notes "PV Enclave Telegram bot @pvenclavebot. Bridge: cc-bridge-pv agent, session-pv. DM-allowlist for G (Telegram id 39172309) only. Created $(date -u +%Y-%m-%d)." ~/.openclaw/vault.kdbx "Bots/PV Enclave Telegram Bot" > /dev/null

echo "[finalize] backing up openclaw.json..."
cp ~/.openclaw/openclaw.json ~/.openclaw/config-backups/openclaw.json.pre-pv-enclave-$(date +%Y%m%d-%H%M%S)

echo "[finalize] editing openclaw.json (channels.telegram.accounts.pv-enclave + bindings)..."
python3 - "$TOKEN" <<'PY'
import json, sys
from pathlib import Path

token = sys.argv[1]
path = Path.home() / ".openclaw/openclaw.json"
cfg = json.loads(path.read_text())

accounts = cfg.setdefault("channels", {}).setdefault("telegram", {}).setdefault("accounts", {})
if "pv-enclave" not in accounts:
    accounts["pv-enclave"] = {
        "botToken": token,
        "dmPolicy": "allowlist",
        "allowFrom": ["39172309"],
        "groupPolicy": "disabled",
        "streaming": "off",
    }
    print("  - added channels.telegram.accounts.pv-enclave (dm allowlist = G)")
else:
    accounts["pv-enclave"]["botToken"] = token
    print("  - updated channels.telegram.accounts.pv-enclave token")

bindings = cfg.setdefault("bindings", [])
already = any(
    b.get("agentId") == "cc-bridge-pv"
    and b.get("match", {}).get("accountId") == "pv-enclave"
    for b in bindings
)
if not already:
    # Prepend: most specific G routes win. This goes in front of everything
    # so pv-enclave bot DMs always reach cc-bridge-pv.
    bindings.insert(
        0,
        {
            "agentId": "cc-bridge-pv",
            "match": {
                "channel": "telegram",
                "accountId": "pv-enclave",
                "peer": {"kind": "dm", "id": "39172309"},
            },
        },
    )
    print("  - prepended binding: telegram pv-enclave dm G → cc-bridge-pv")

path.write_text(json.dumps(cfg, indent=2) + "\n")
print("  - wrote config")
PY

echo "[finalize] restarting gateway..."
bash ~/.openclaw/workspace.old/scripts/restart-gateway.sh "finalize pv-enclave: add @pvenclavebot → cc-bridge-pv"

echo
echo "[finalize] DONE. pv-enclave bot is now routed to session-pv."
echo "Test from G's Telegram: DM @pvenclavebot with a message."
