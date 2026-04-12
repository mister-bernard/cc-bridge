#!/usr/bin/env python3
"""
apply-config-edits-v5.py — groups-agent build (task t13a046)

Adds the public-facing cc-bridge-groups agent to openclaw.json for strangers,
groups, and non-G DMs. Uses a dedicated session-groups bridge session with a
strict public-facing system prompt (baked into daemon.js) AND --disallowedTools
at the claude CLI level so Bash/Edit/Write are literally unavailable even if a
jailbreak succeeds at the prompt level.

This edit adds:
  1. models.providers.cc-bridge.models += session-groups
  2. agents.list[] += cc-bridge-groups (tools.profile: minimal, fallbacks: [])
  3. agents.defaults.models += alias entry for cc-bridge/session-groups
  4. A DRAFTED binding chunk at the TOP of the bindings[] array — COMMENTED
     OUT in the written JSON comment form is impossible (JSON has no comments),
     so we write them as new bindings but with agentId = "cc-bridge-groups-DRAFT"
     which won't match any real agent until G manually flips it to "cc-bridge-groups".
     This lets G verify the binding shape and then enable with a single sed.

Actually: since JSON doesn't support comments and we don't want to half-enable
bindings, this script DOES NOT add the bindings. It prints the exact bindings
G should add once he's ready, and the way to add them (apply-config-edits-v5-enable-bindings.py).
The groups-agent itself is built + available via the HTTP API for testing
without any risk to live stranger traffic.

Idempotent. Safe to re-run.
"""

import json
import sys
from pathlib import Path

CONFIG = Path.home() / ".openclaw/openclaw.json"


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    changes: list[str] = []

    # --- 1. Add session-groups model to cc-bridge provider ---------------
    provider = cfg.get("models", {}).get("providers", {}).get("cc-bridge")
    if not provider:
        print("ERROR: models.providers.cc-bridge missing — run earlier edit scripts first", file=sys.stderr)
        return 1
    models_list = provider.setdefault("models", [])
    if not any(m.get("id") == "session-groups" for m in models_list):
        models_list.append(
            {
                "id": "session-groups",
                "name": "CC Bridge (groups / public-facing)",
                "reasoning": False,
                "input": ["text"],
                "contextWindow": 200000,
                "maxTokens": 8192,
            }
        )
        changes.append("added cc-bridge/session-groups to provider models")

    # --- 2. Add cc-bridge-groups agent ----------------------------------
    agents_list = cfg.setdefault("agents", {}).setdefault("list", [])
    if not any(a.get("id") == "cc-bridge-groups" for a in agents_list):
        agents_list.append(
            {
                "id": "cc-bridge-groups",
                "default": False,
                "name": "CC Bridge (groups / public-facing)",
                "workspace": "/home/openclaw/projects/cc-bridge/workspace",
                "model": {
                    "primary": "cc-bridge/session-groups",
                    # NO fallbacks — no silent rollover to other models.
                    # If the bridge is down, callers get a clean error,
                    # not a different-model reply from an agent that
                    # doesn't have the public-facing restrictions baked in.
                    "fallbacks": [],
                },
                "tools": {
                    "profile": "minimal",
                    "exec": {"security": "full", "ask": "off"},
                },
            }
        )
        changes.append("added agents.list[] entry for cc-bridge-groups")

    # --- 3. Alias entry for cc-bridge/session-groups --------------------
    defaults_models = (
        cfg.setdefault("agents", {})
        .setdefault("defaults", {})
        .setdefault("models", {})
    )
    if "cc-bridge/session-groups" not in defaults_models:
        defaults_models["cc-bridge/session-groups"] = {
            "alias": "CC Groups"
        }
        changes.append("added alias entry for cc-bridge/session-groups")

    # --- 4. Binding drafts (NOT applied — print for G) -------------------
    draft_bindings = [
        {
            "agentId": "cc-bridge-groups",
            "match": {
                "channel": "telegram",
                "accountId": "default",
                "peer": {"kind": "group", "id": "*"},
            },
        },
        {
            "agentId": "cc-bridge-groups",
            "match": {
                "channel": "telegram",
                "accountId": "default",
                "peer": {"kind": "dm", "id": "*"},
            },
        },
        {
            "agentId": "cc-bridge-groups",
            "match": {
                "channel": "signal",
                "peer": {"kind": "group", "id": "*"},
            },
        },
        {
            "agentId": "cc-bridge-groups",
            "match": {
                "channel": "signal",
                "peer": {"kind": "dm", "id": "*"},
            },
        },
    ]

    # Write
    if changes:
        serialized = json.dumps(cfg, indent=2) + "\n"
        json.loads(serialized)  # sanity re-parse
        CONFIG.write_text(serialized)
        print("=== v5 changes applied ===")
        for c in changes:
            print(f"  - {c}")
        print()
        print(f"wrote {len(serialized)} bytes to {CONFIG}")
    else:
        print("no changes — config already up to date")

    print()
    print("=== NOT YET WIRED TO LIVE TRAFFIC ===")
    print()
    print("The groups agent is BUILT and testable via the HTTP API:")
    print("  curl -X POST http://127.0.0.1:18789/v1/chat/completions \\")
    print("    -H 'Authorization: Bearer <gateway_token>' \\")
    print("    -H 'Content-Type: application/json' \\")
    print('    -d \'{"model":"openclaw/cc-bridge-groups","messages":[{"role":"user","content":"hi"}]}\'')
    print()
    print("When G is ready to ROUTE LIVE stranger traffic to it, add these 4 bindings")
    print("to the TOP of openclaw.json bindings[] (prepend order — groups first, then dms)")
    print("so they take priority over the priority-groups catch-alls already in place:")
    print()
    print(json.dumps(draft_bindings, indent=2))
    print()
    print("Bindings NOT applied by this script. Apply them via:")
    print("  bash scripts/restart-gateway.sh (after editing openclaw.json by hand)")
    print("OR: run scripts/apply-config-edits-v5-enable-bindings.py (to be created)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
