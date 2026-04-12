#!/usr/bin/env python3
"""
apply-config-edits-v2.py — follow-ups to apply-config-edits.py:

  1. Tighten main cc-bridge Telegram binding with accountId="default" so a
     future G-added bot doesn't accidentally inherit cc-bridge as its handler.
  2. Prepend a Signal DM binding for G → cc-bridge (same session-g).
  3. Register session-pv in the cc-bridge provider's models list (pv-enclave
     will use it once the bot exists).
  4. Append cc-bridge-pv agent with primary cc-bridge/session-pv. Not yet
     wired to any binding — awaiting the @pvenclavebot token from G.

All edits idempotent — safe to re-run.
"""

import json
import sys
from pathlib import Path

CONFIG = Path.home() / ".openclaw/openclaw.json"


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    changes: list[str] = []

    # --- 1. Tighten main cc-bridge TG binding with accountId=default ---
    bindings = cfg.setdefault("bindings", [])
    for b in bindings:
        if (
            b.get("agentId") == "cc-bridge"
            and b.get("match", {}).get("channel") == "telegram"
            and b.get("match", {}).get("peer", {}).get("id") == "39172309"
        ):
            if "accountId" not in b["match"]:
                b["match"]["accountId"] = "default"
                changes.append('tightened main cc-bridge telegram binding: accountId="default"')
            break

    # --- 2. Prepend Signal DM binding for G → cc-bridge ---
    sig_already = any(
        b.get("agentId") == "cc-bridge"
        and b.get("match", {}).get("channel") == "signal"
        and b.get("match", {}).get("peer", {}).get("id") == "+12084004000"
        for b in bindings
    )
    if not sig_already:
        # Prepend at the very top so it wins over the existing opus-dm
        # signal DM binding (which would otherwise still match).
        bindings.insert(
            0,
            {
                "agentId": "cc-bridge",
                "match": {
                    "channel": "signal",
                    "peer": {"kind": "dm", "id": "+12084004000"},
                },
            },
        )
        changes.append("prepended Signal DM binding: G → cc-bridge")

    # --- 3. Add session-pv to cc-bridge provider models list ---
    provider = cfg.get("models", {}).get("providers", {}).get("cc-bridge")
    if not provider:
        print("ERROR: models.providers.cc-bridge not found — run apply-config-edits.py first", file=sys.stderr)
        return 1
    models_list = provider.setdefault("models", [])
    if not any(m.get("id") == "session-pv" for m in models_list):
        models_list.append(
            {
                "id": "session-pv",
                "name": "CC Bridge (session-pv)",
                "reasoning": False,
                "input": ["text"],
                "contextWindow": 200000,
                "maxTokens": 8192,
            }
        )
        changes.append("added session-pv to cc-bridge provider models list")

    # --- 4. Append cc-bridge-pv agent ---
    agents_list = cfg.setdefault("agents", {}).setdefault("list", [])
    if not any(a.get("id") == "cc-bridge-pv" for a in agents_list):
        agents_list.append(
            {
                "id": "cc-bridge-pv",
                "default": False,
                "name": "CC Bridge (PV-enclave)",
                "workspace": "/home/openclaw/projects/cc-telegram-bridge/workspace",
                "model": {
                    "primary": "cc-bridge/session-pv",
                    "fallbacks": [
                        "claude-cli/sonnet-4.5",
                        "claude-cli/opus-4.6",
                        "deepseek/deepseek-chat",
                        "anthropic/claude-sonnet-4-5",
                    ],
                },
                "tools": {
                    "profile": "minimal",
                    "exec": {"security": "full", "ask": "off"},
                },
            }
        )
        changes.append("added agents.list[] entry for cc-bridge-pv")

    if not changes:
        print("no changes — config already up to date")
        return 0

    serialized = json.dumps(cfg, indent=2) + "\n"
    json.loads(serialized)  # sanity re-parse
    CONFIG.write_text(serialized)

    print("=== v2 changes applied ===")
    for c in changes:
        print(f"  - {c}")
    print()
    print(f"wrote {len(serialized)} bytes to {CONFIG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
