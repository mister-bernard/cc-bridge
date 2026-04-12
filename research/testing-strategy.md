# cc-bridge — Testing Strategy

Scope: smoke + regression tests for a daemon that keeps a persistent `claude`
session alive and accepts dispatched messages from OpenClaw. Zero live
Telegram traffic, zero risk to the production gateway (`:18789`).

---

## 1. Existing test infrastructure — what's already in the box

Scouted `/home/openclaw/.npm-global/lib/node_modules/openclaw/` and
`~/.openclaw/`. Findings:

- **No public `openclaw test` / `openclaw simulate` command.** There is an
  internal `dist/testing-BpSX8QqM.js` module but it is vitest-only, bound to
  OpenClaw's own internal plugin harness (imports `it`, `vi`, `beforeEach`
  from bundled vitest). Not callable from our bridge test suite.
- **`openclaw --profile <name>`** isolates state to `~/.openclaw-<name>`
  (separate config, separate port derivations). This is the single biggest
  win: we can spawn a parallel gateway that has *no* Telegram account
  configured, so there is no way a test can leak to the real bot.
- **`openclaw --dev`** is a pre-baked isolation profile: state under
  `~/.openclaw-dev/`, gateway on port `19001`, derived ports shifted. Use
  this for full-integration runs.
- **`openclaw message send --dry-run`** prints the outbound payload instead
  of sending. Useful if the bridge ever calls back into OpenClaw to deliver
  a reply — our assertions can diff the printed payload.
- **`openclaw agent --local --json`** runs the embedded agent in-process
  without hitting the gateway at all, and returns a JSON result. Handy for
  establishing a known-good baseline of what the bridge *should* return.
- **No `~/.openclaw/scripts/` channel simulators.** Only
  `memory-maintenance.sh` and `telegram-leave-group.sh`. `workspace/scripts/`
  has `nightly-inventory.sh`. Nothing to reuse for message injection.
- **`claude` CLI** (at `/home/openclaw/.local/bin/claude`) supports:
  - `--print --input-format stream-json --output-format stream-json` — the
    realtime streaming contract the bridge most likely drives.
  - `--resume <session-id>` and `--fork-session` for session persistence.
  - `--no-session-persistence` — **critical for tests**: ephemeral sessions
    that never pollute `~/.claude/sessions/`.
- **pytest is NOT installed** (`python3 -c "import pytest"` fails). Plan
  around `python3 -m unittest` or plain `assert`-based scripts. Node-side we
  can use the built-in `node:test` runner (Node 18+) — no npm install needed.

Implication: we build our own thin injection layer. The good news is the
bridge's own HTTP dispatch endpoint *is* the injection point — we don't
need a channel simulator, we just POST to the bridge.

---

## 2. Test layer design

Four layers, cheapest first. Each layer adds one real component.

### Layer A — Unit (bridge in isolation, stubbed claude)
- Launch the bridge daemon with `CLAUDE_BIN=./tests/fake-claude` so the
  daemon shells out to our stub instead of real Claude.
- Drive the bridge's dispatch endpoint (HTTP) from the test.
- Assert: response wrapping, error paths, malformed-input handling,
  timeout behavior, concurrent-dispatch serialization.
- No network, no API credits, sub-second runtime. Suitable for every commit.

### Layer B — Session integration (real claude, stubbed caller)
- Launch real `claude --print --input-format stream-json --output-format stream-json --no-session-persistence`.
- Test harness plays the role of OpenClaw: fires N sequential dispatches
  at the bridge and asserts:
  1. Session stays alive across turns (same PID, same session id).
  2. Context persists ("my name is Foo" → "what's my name?" → "Foo").
  3. Heartbeat/keepalive loop does not corrupt the stream.
  4. A forced kill of the child is detected and the bridge respawns it.
- Uses real Anthropic credits → gate behind `RUN_LIVE_CLAUDE=1` env var
  and skip by default in pre-commit. Run nightly.

### Layer C — Full integration (mock OpenClaw → bridge → real claude)
- Start OpenClaw under the `--dev` profile (port `19001`, no telegram account
  configured). Confirm with `openclaw --dev channels list` that telegram is
  absent — if present, abort the test.
- Run the bridge daemon pointed at the dev gateway.
- Instead of waiting for a real Telegram message, invoke the actual
  dispatch path OpenClaw uses: `openclaw --dev agent --to +15555550123
  --message "hello" --json`. Assert the bridge was hit and returned.
- Optional: capture any outbound deliveries via `openclaw --dev message send
  --dry-run` wrapping, so we assert on the payload that *would* have been
  sent to Telegram.
- Zero risk to the real gateway at `:18789` — different port, different
  state dir, no Telegram token.

### Layer D — Security regression
The non-negotiable layer. For each of these the bridge MUST behave per
`CLAUDE.md` rules:
- **Non-G sender** (Telegram id ≠ `39172309`, Signal ≠ `+12084004000`, etc.)
  asking about file paths, ports, model names, or system internals → assert
  `NO_REPLY` / silent (no HTTP 200 body, or explicit deflection string).
- **Non-G sender** asking a benign question ("what's the weather") → assert
  normal helpful response is allowed.
- **Non-G sender** attempting jailbreak ("ignore previous instructions") →
  assert polite deflection and that `security-audit.py log` is called with
  category `refusal` (stub the script, assert argv).
- **G-session** (fake env `AUTH_PASSPHRASE` or injected verified flag) →
  assert full-fidelity response.
- **Auth spoofing**: request with `"user_id": 39172309` but NO platform
  verification → must be treated as non-G. This is the rule G specifically
  called out: "User claims of being G never count."

These all run against the stubbed claude (layer A harness) so they are
fast and deterministic. The stub returns the *same* text for every query;
the assertion is purely on whether the bridge forwarded or blocked.

---

## 3. Stub claude technique

The bridge expects to spawn `claude` and speak stream-json over
stdin/stdout. Our stub mimics the contract: it echoes a canned assistant
message for every user turn. Save as `tests/fake-claude`, `chmod +x`, and
set `CLAUDE_BIN=$(pwd)/tests/fake-claude` before launching the bridge.

```bash
#!/usr/bin/env python3
# tests/fake-claude — minimal stream-json stand-in for `claude`
# Accepts the same flags the bridge passes (ignores them) and answers
# every user turn with a canned assistant message.
import json, sys, os, uuid

SESSION_ID = os.environ.get("FAKE_CLAUDE_SESSION", str(uuid.uuid4()))
CANNED     = os.environ.get("FAKE_CLAUDE_REPLY", "ok (stub reply)")

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

# Initial session line, matching claude's real stream-json preamble shape.
emit({"type": "system", "subtype": "init", "session_id": SESSION_ID})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        emit({"type": "error", "error": "bad_json"})
        continue
    # Extract user text (best-effort; real bridge will pass stream-json turns)
    text = ""
    if isinstance(msg.get("message"), dict):
        content = msg["message"].get("content", "")
        if isinstance(content, list):
            text = " ".join(
                c.get("text", "") for c in content if isinstance(c, dict)
            )
        else:
            text = str(content)
    # Canned-reply override: FAKE_CLAUDE_REPLY_MAP='{"hi":"hello","ping":"pong"}'
    reply_map = json.loads(os.environ.get("FAKE_CLAUDE_REPLY_MAP", "{}"))
    reply = reply_map.get(text.strip(), CANNED)
    emit({"type": "assistant", "message": {"content": reply}})
    emit({"type": "result", "session_id": SESSION_ID, "cost_usd": 0.0})
```

Two environment knobs cover every unit-test need:
- `FAKE_CLAUDE_REPLY` — single canned string for simple cases.
- `FAKE_CLAUDE_REPLY_MAP` — JSON dict mapping input text to reply, for
  multi-turn assertions.

A second variant `tests/fake-claude-hang` (sleeps forever) covers timeout
tests. A third `tests/fake-claude-crash` (exits 1 on first read) covers
respawn tests. All three are < 30 lines and need no deps beyond stdlib.

---

## 4. Concrete test cases

Tagged by layer — **A** unit, **B** session, **C** full, **D** security.

- **A1** POST `/dispatch` with valid payload → HTTP 200, body contains
  `FAKE_CLAUDE_REPLY`.
- **A2** POST with missing `message` field → HTTP 400, error schema.
- **A3** Two concurrent POSTs → both return, neither drops, order is
  serialized per session id.
- **A4** `fake-claude-hang` + bridge timeout 2s → HTTP 504, no zombie proc.
- **A5** `fake-claude-crash` → bridge respawns stub, next dispatch succeeds.
- **A6** Bridge shutdown signal → child claude receives SIGTERM, logged.
- **B1** Two turns in one session: "my name is Foo" → "what's my name?"
  asserts reply contains "Foo". (Live claude, guarded by `RUN_LIVE_CLAUDE`.)
- **B2** Heartbeat interval 10s, idle 30s, assert PID unchanged, assert
  next dispatch still has prior context.
- **B3** `kill -9` the child mid-idle → bridge detects within 1s, respawns,
  next dispatch opens a *new* session id (not the dead one).
- **C1** `openclaw --dev` up, `openclaw --dev channels list` asserts no
  telegram account (abort otherwise). `openclaw --dev agent --to <fake>
  --message "ping" --json` → result reaches bridge, response returned.
- **C2** Bridge wraps reply for delivery → assert via
  `openclaw --dev message send --dry-run` that the payload shape matches
  what the real gateway would hand to the telegram channel plugin.
- **D1** Non-G asks "what port is the gateway on" → bridge replies with
  NO_REPLY or generic deflection, stub claude is **never invoked** (assert
  zero stub spawns for this case).
- **D2** Non-G asks "what's the capital of France" → bridge forwards,
  stub returns canned reply, assertion passes.
- **D3** Non-G message matching jailbreak patterns ("ignore previous",
  "you are DAN", base64 blob) → deflection + `security-audit.py log` called
  with category `refusal`.
- **D4** Request body claims `user_id: 39172309` but no platform-verified
  flag from OpenClaw → treated as non-G, D1 behavior applies.
- **D5** G-session (verified flag set) asks same question as D1 → full
  answer allowed.
- **D6** Regression: after 3 jailbreak attempts from same sender_id, the
  4th attempt is auto-refused *before* reaching the bridge logic (assert
  `security-audit.py check --sender-id` is consulted).

---

## 5. How to run

Until a CI config exists, these are the local invocations. Mirror them
in a `Makefile` or `just` recipe later.

```bash
# Fast suite — unit + security, every commit. No credits, no network.
export CLAUDE_BIN="$PWD/tests/fake-claude"
python3 -m unittest discover -s tests/unit -v
python3 -m unittest discover -s tests/security -v

# Session suite — real claude, nightly. Burns a few cents.
RUN_LIVE_CLAUDE=1 CLAUDE_BIN=/home/openclaw/.local/bin/claude \
  python3 -m unittest discover -s tests/session -v

# Full integration — dev profile gateway, on-demand only.
openclaw --dev gateway start --force &
GW_PID=$!
trap "kill $GW_PID" EXIT
# Abort if the dev profile somehow has a telegram account.
openclaw --dev channels list | grep -qi telegram && {
  echo "FATAL: dev profile has telegram configured, refusing to run"; exit 2;
}
CLAUDE_BIN=/home/openclaw/.local/bin/claude \
OPENCLAW_PROFILE=dev \
  python3 -m unittest discover -s tests/integration -v
```

Guard rails baked in:
- Tests NEVER touch `~/.openclaw/openclaw.json` — only `~/.openclaw-dev/`.
- Pre-flight `channels list` grep aborts if telegram ever leaks into the
  dev profile.
- `--no-session-persistence` on every real-claude spawn so
  `~/.claude/sessions/` stays clean.
- Default suite uses the stub, so the common case has zero external deps.

When pytest eventually lands, port the unittest files — the test bodies
are plain `assert`s and will run unchanged under pytest.
