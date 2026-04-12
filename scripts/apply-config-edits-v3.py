#!/usr/bin/env python3
"""
apply-config-edits-v3.py — finalize pv-enclave routing.

Turns out @pvenclavebot is the EXISTING `pv-fund` telegram account in
openclaw.json (internal name "pv-fund", bot username "pvenclavebot").
No new bot needed. Just:

  1. Prepend a binding: telegram/accountId=pv-fund/dm/G → cc-bridge-pv
  2. Leave the existing `pv-fund` agent binding in place as a shadow (still
     handles its cron jobs and non-DM flows; it just loses interactive DMs
     to cc-bridge-pv).
  3. Update the cc-bridge-pv agent's `workspace` field to point at the PV
     fund workspace so OpenClaw internals that read it (tool scoping, etc.)
     see the right context. Note: this does NOT change the daemon's
     CLAUDE_CWD — that's controlled by the systemd unit / bridge .env.

Idempotent.
"""

import json
import sys
from pathlib import Path

CONFIG = Path.home() / ".openclaw/openclaw.json"

PV_WORKSPACE = "/home/openclaw/.openclaw/workspace-pv-fund"
PV_TELEGRAM_ACCOUNT = "pv-fund"
G_TG_ID = "39172309"


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    changes: list[str] = []

    # --- 1. Prepend pv-enclave DM binding -------------------------------
    bindings = cfg.setdefault("bindings", [])
    already = any(
        b.get("agentId") == "cc-bridge-pv"
        and b.get("match", {}).get("channel") == "telegram"
        and b.get("match", {}).get("accountId") == PV_TELEGRAM_ACCOUNT
        and b.get("match", {}).get("peer", {}).get("id") == G_TG_ID
        for b in bindings
    )
    if not already:
        bindings.insert(
            0,
            {
                "agentId": "cc-bridge-pv",
                "match": {
                    "channel": "telegram",
                    "accountId": PV_TELEGRAM_ACCOUNT,
                    "peer": {"kind": "dm", "id": G_TG_ID},
                },
            },
        )
        changes.append(
            "prepended bindings[] rule: telegram(pv-fund/@pvenclavebot) dm G → cc-bridge-pv"
        )

    # --- 2. Update cc-bridge-pv agent workspace ------------------------
    agents_list = cfg.get("agents", {}).get("list", [])
    pv_agent = None
    for a in agents_list:
        if a.get("id") == "cc-bridge-pv":
            pv_agent = a
            if a.get("workspace") != PV_WORKSPACE:
                a["workspace"] = PV_WORKSPACE
                changes.append(
                    f"set cc-bridge-pv.workspace = {PV_WORKSPACE}"
                )
            break
    if pv_agent is None:
        print("ERROR: agents.list[cc-bridge-pv] not found — run v2 first", file=sys.stderr)
        return 1

    # --- 3. Strip fallbacks from BOTH bridge agents --------------------
    # G wants the bridge to fail loud ("not available") instead of silently
    # rolling over to another model that would lack the persistent-session
    # context. If cc-bridge is down, return an error, don't pretend.
    for a in agents_list:
        if a.get("id") in ("cc-bridge", "cc-bridge-pv"):
            model = a.setdefault("model", {})
            if model.get("fallbacks"):
                model["fallbacks"] = []
                changes.append(
                    f"cleared fallbacks on agents.list[{a['id']}].model.fallbacks (no silent rollover)"
                )

    # --- 4. Reroute pv-fund agent's crons through cc-bridge ------------
    # G's ask: the existing pv-fund analyst agent runs its scheduled crons
    # through the broken claude-cli backend. Reroute so crons dispatch
    # through the cc-bridge provider → persistent session-pv child. Same
    # warm sonnet process G's DMs use, much better quality than the cold
    # claude-cli fallback chain.
    #
    # We keep pv-fund.tools.allow intact — those tool names are irrelevant
    # once the model is cc-bridge (CC handles tools internally inside the
    # persistent session; OpenClaw sees only final text). Harmless but
    # stable across rollback.
    for a in agents_list:
        if a.get("id") == "pv-fund":
            model = a.setdefault("model", {})
            if model.get("primary") != "cc-bridge/session-pv":
                model["primary"] = "cc-bridge/session-pv"
                changes.append(
                    "rerouted pv-fund.model.primary → cc-bridge/session-pv (warm CC for crons)"
                )
            # Same no-silent-rollover rule applies to the pv-fund analyst.
            if model.get("fallbacks"):
                model["fallbacks"] = []
                changes.append(
                    "cleared fallbacks on agents.list[pv-fund].model.fallbacks"
                )
            break

    if not changes:
        print("no changes — config already up to date")
        return 0

    serialized = json.dumps(cfg, indent=2) + "\n"
    json.loads(serialized)  # sanity re-parse
    CONFIG.write_text(serialized)

    print("=== v3 changes applied ===")
    for c in changes:
        print(f"  - {c}")
    print()
    print(f"wrote {len(serialized)} bytes to {CONFIG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
