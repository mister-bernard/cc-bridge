#!/usr/bin/env python3
"""
apply-config-edits-v4.py — ephemeral cc-bridge sessions for openclaw crons.

G's ask (2026-04-10 night): "set crons to use new cc-bridge agents that spin
down after use to not clog up the system. yeah do that that's clean."

Strategy: repoint the existing cron-heavy agents' primaries at dedicated
cc-bridge session ids that auto-expire via CC_BRIDGE_SESSION_IDLE_TIMEOUTS_MS.
The cron-heavy agents today (from ~/.openclaw/cron/jobs.json) are:
  - fast-dm: 10 active crons (ai news, podcast, weekly audits, market cards, etc.)
  - opus-dm: 2 active crons (Bernard System Brief, WAR Dashboard Update)
  - pv-fund: 2 active crons (already routed to cc-bridge/session-pv in v3)

After this edit:
  - fast-dm.model.primary  → cc-bridge/session-cron-fast
  - opus-dm.model.primary  → cc-bridge/session-cron-opus
  - pv-fund already done in v3

The corresponding session ids get short idle timeouts (10 min) in the bridge
.env via CC_BRIDGE_SESSION_IDLE_TIMEOUTS_MS so they spin down after the burst
of cron activity completes.

NOTE: fast-dm and opus-dm still have their original `tools` config with lots
of OpenClaw-layer tool names. Those fields are inert when primary is
cc-bridge/* because Claude Code handles tools internally inside the
persistent session — OpenClaw only sees final text. No behavior change.

Idempotent. Safe to re-run.
"""

import json
import sys
from pathlib import Path

CONFIG = Path.home() / ".openclaw/openclaw.json"

# Agent → session id mapping.
REROUTES = {
    "fast-dm": "session-cron-fast",
    "opus-dm": "session-cron-opus",
}


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    changes: list[str] = []

    # --- 1. Add session ids to cc-bridge provider models list --------
    provider = cfg.get("models", {}).get("providers", {}).get("cc-bridge")
    if not provider:
        print("ERROR: models.providers.cc-bridge missing — run earlier apply-config-edits.py scripts first", file=sys.stderr)
        return 1
    models_list = provider.setdefault("models", [])
    existing_ids = {m.get("id") for m in models_list}

    for sid in REROUTES.values():
        if sid in existing_ids:
            continue
        models_list.append(
            {
                "id": sid,
                "name": f"CC Bridge ({sid})",
                "reasoning": False,
                "input": ["text"],
                "contextWindow": 200000,
                "maxTokens": 8192,
            }
        )
        changes.append(f"added cc-bridge/{sid} to provider models")

    # --- 2. Reroute each agent's primary -----------------------------
    agents_list = cfg.get("agents", {}).get("list", [])
    for a in agents_list:
        aid = a.get("id")
        if aid not in REROUTES:
            continue
        model = a.setdefault("model", {})
        target = f"cc-bridge/{REROUTES[aid]}"
        if model.get("primary") != target:
            model["primary"] = target
            changes.append(f"{aid}.model.primary → {target}")
        # No silent rollover — same rule as the other cc-bridge agents.
        if model.get("fallbacks"):
            model["fallbacks"] = []
            changes.append(f"cleared fallbacks on {aid}.model.fallbacks")

    if not changes:
        print("no changes — config already up to date")
        return 0

    serialized = json.dumps(cfg, indent=2) + "\n"
    json.loads(serialized)  # sanity re-parse
    CONFIG.write_text(serialized)

    print("=== v4 changes applied ===")
    for c in changes:
        print(f"  - {c}")
    print()
    print(f"wrote {len(serialized)} bytes to {CONFIG}")
    print()
    print("REMINDER: also update the bridge .env:")
    print('  CC_BRIDGE_SESSION_IDLE_TIMEOUTS_MS={"session-g":0,"session-pv":21600000,"session-cron-fast":600000,"session-cron-opus":600000}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
