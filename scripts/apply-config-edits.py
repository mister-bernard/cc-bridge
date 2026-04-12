#!/usr/bin/env python3
"""
apply-config-edits.py — atomic edits to ~/.openclaw/openclaw.json for:
  1. Register `models.providers.cc-bridge` (OpenAI-compat, loopback).
  2. Append `cc-bridge` agent to `agents.list[]` (primary = cc-bridge/session-g).
  3. Prepend a `bindings[]` rule routing G's telegram DM to `cc-bridge`.
  4. Strip every `deepinfra/Qwen/*` entry from every `fallbacks` array
     anywhere in the config (G's separate ask — remove qwen as a fallback
     gatekeeper). Provider definition + alias entries kept intact.

Bearer is read from the already-deployed bridge .env (not the vault) so
this script is hermetic if re-run. Vault is the canonical source but the
.env is the live reference.
"""

import json
import os
import re
import sys
from pathlib import Path

CONFIG = Path.home() / ".openclaw/openclaw.json"
BRIDGE_ENV = Path.home() / "projects/cc-bridge/.env"


def load_env(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def main() -> int:
    env = load_env(BRIDGE_ENV)
    bearer = env.get("CC_BRIDGE_PROVIDER_KEY", "")
    if not bearer:
        print("ERROR: CC_BRIDGE_PROVIDER_KEY not found in bridge .env", file=sys.stderr)
        return 1

    cfg = json.loads(CONFIG.read_text())
    changes: list[str] = []

    # --- Edit 1: models.providers.cc-bridge ------------------------------
    providers = cfg.setdefault("models", {}).setdefault("providers", {})
    if "cc-bridge" in providers:
        print("NOTE: models.providers.cc-bridge already exists — leaving as-is")
    else:
        providers["cc-bridge"] = {
            "baseUrl": "http://127.0.0.1:18901/v1",
            "apiKey": bearer,
            "api": "openai-completions",
            "models": [
                {
                    "id": "session-g",
                    "name": "CC Bridge (session-g)",
                    "reasoning": False,
                    "input": ["text"],
                    "contextWindow": 200000,
                    "maxTokens": 8192,
                }
            ],
        }
        changes.append("added models.providers.cc-bridge")

    # --- Edit 2: agents.list[] cc-bridge entry ---------------------------
    agents_list = cfg.setdefault("agents", {}).setdefault("list", [])
    if any(a.get("id") == "cc-bridge" for a in agents_list):
        print("NOTE: agents.list[] cc-bridge already exists — leaving as-is")
    else:
        agents_list.append(
            {
                "id": "cc-bridge",
                "default": False,
                "name": "CC Bridge (persistent)",
                "workspace": "/home/openclaw/projects/cc-bridge/workspace",
                "model": {
                    "primary": "cc-bridge/session-g",
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
        changes.append("added agents.list[] entry for cc-bridge")

    # --- Edit 3: prepend bindings[] rule for G's Telegram DM -------------
    bindings = cfg.setdefault("bindings", [])
    new_binding = {
        "agentId": "cc-bridge",
        "match": {
            "channel": "telegram",
            "peer": {"kind": "dm", "id": "39172309"},
        },
    }
    # Look for an existing cc-bridge binding with same match (idempotency)
    already = any(
        b.get("agentId") == "cc-bridge"
        and b.get("match", {}).get("channel") == "telegram"
        and b.get("match", {}).get("peer", {}).get("id") == "39172309"
        for b in bindings
    )
    if already:
        print("NOTE: cc-bridge binding already present — leaving as-is")
    else:
        bindings.insert(0, new_binding)
        changes.append("prepended bindings[] rule: telegram DM G → cc-bridge")

    # --- Edit 4: strip deepinfra/Qwen/* from every fallbacks[] array -----
    qwen_rx = re.compile(r"^deepinfra/Qwen/")

    def strip_qwen_from_fallbacks(node, path: str) -> int:
        removed = 0
        if isinstance(node, dict):
            if "fallbacks" in node and isinstance(node["fallbacks"], list):
                before = list(node["fallbacks"])
                after = [m for m in before if not (isinstance(m, str) and qwen_rx.match(m))]
                if len(after) != len(before):
                    removed += len(before) - len(after)
                    node["fallbacks"] = after
                    changes.append(
                        f"stripped {len(before) - len(after)} qwen entries from {path}.fallbacks"
                    )
            for k, v in node.items():
                removed += strip_qwen_from_fallbacks(v, f"{path}.{k}" if path else k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                removed += strip_qwen_from_fallbacks(v, f"{path}[{i}]")
        return removed

    total_removed = strip_qwen_from_fallbacks(cfg, "")
    if total_removed:
        print(f"stripped {total_removed} qwen fallback entries across the config")

    # --- Write back ------------------------------------------------------
    if not changes:
        print("no changes — config already up to date")
        return 0

    serialized = json.dumps(cfg, indent=2) + "\n"
    # Final sanity parse before writing.
    json.loads(serialized)
    CONFIG.write_text(serialized)

    print()
    print("=== Changes applied ===")
    for c in changes:
        print(f"  - {c}")
    print()
    print(f"wrote {len(serialized)} bytes to {CONFIG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
