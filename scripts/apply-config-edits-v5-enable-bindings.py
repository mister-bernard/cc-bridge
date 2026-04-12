#!/usr/bin/env python3
"""
apply-config-edits-v5-enable-bindings.py — flip groups-agent live

Replaces agentId="priority-groups" with agentId="cc-bridge-groups" on the
4 wildcard catch-all bindings at the bottom of bindings[]:
  - telegram group * → cc-bridge-groups
  - signal group *   → cc-bridge-groups
  - signal dm *      → cc-bridge-groups
  - telegram dm *    → cc-bridge-groups

Specific group bindings (for known priority groups — currently indices 5-9:
-5098876375, -5281764808, etc.) are LEFT ALONE on priority-groups. If G wants
those flipped too, that's a separate edit.

Specific G peer bindings (cc-bridge for G's TG/Signal DMs, pv-fund account) are
LEFT ALONE — they live at lower indices and win by position over the catch-alls.

Idempotent: if a binding already targets cc-bridge-groups, it's a no-op.
"""

import json
import sys
from pathlib import Path

CONFIG = Path.home() / ".openclaw/openclaw.json"


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    bindings = cfg.get("bindings", [])

    # Safety check — confirm cc-bridge-groups agent exists
    agents = cfg.get("agents", {}).get("list", [])
    if not any(a.get("id") == "cc-bridge-groups" for a in agents):
        print("ERROR: cc-bridge-groups agent not found — run apply-config-edits-v5.py first", file=sys.stderr)
        return 1

    # Find the wildcard catch-alls
    changes: list[str] = []
    for i, b in enumerate(bindings):
        m = b.get("match", {})
        peer = m.get("peer", {})
        if peer.get("id") != "*":
            continue  # only wildcard catch-alls
        if b.get("agentId") != "priority-groups":
            continue  # only flip priority-groups, skip already-flipped
        channel = m.get("channel", "")
        kind = peer.get("kind", "")
        b["agentId"] = "cc-bridge-groups"
        changes.append(f"  [{i}] {channel}/{kind}/* : priority-groups → cc-bridge-groups")

    if not changes:
        print("no changes — wildcard catch-all bindings already on cc-bridge-groups")
        return 0

    serialized = json.dumps(cfg, indent=2) + "\n"
    json.loads(serialized)  # sanity re-parse
    CONFIG.write_text(serialized)

    print("=== bindings flipped ===")
    for c in changes:
        print(c)
    print()
    print(f"wrote {len(serialized)} bytes to {CONFIG}")
    print()
    print("NEXT: bash ~/.openclaw/workspace.old/scripts/restart-gateway.sh 'flip groups-agent live'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
