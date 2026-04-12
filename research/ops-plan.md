# cc-telegram-bridge — Ops Plan

Owner: ops (cc-telegram-bridge team). Scope: how the bridge daemon runs as
a managed service with heartbeat, auto-restart, credential plumbing, and
observability. Read-only inspection of real services; all drafts in
`/tmp/muxxin-demo/app/deploy/`.

---

## 1. House systemd style

Cited units: `openclaw-gateway.service`, `telnyx-sms.service`,
`twilio-sms.service`, `wire-bridge.service` (plus `bot-poller.{service,timer}`
and `health-watchdog.service` for the timer-driven pattern).

Patterns shared across the long-running daemons:

- **`Type=simple`** (explicit in twilio/telnyx, implicit elsewhere). No unit
  on this host uses `Type=notify` or `WatchdogSec=` — sd_notify is **not**
  part of the house style.
- **`Restart=always`** with `RestartSec=3–10`. `openclaw-gateway` also sets
  `SuccessExitStatus=0 143`, `TimeoutStopSec=30`, `KillMode=control-group`
  so SIGTERM-on-graceful-shutdown isn't treated as a failure.
- **`After=network-online.target`** (+ `Wants=` same) for anything that
  talks to the outside world. Services that depend on the gateway chain
  off it: `wire-bridge.service` has
  `After=network-online.target openclaw-gateway.service the-wire.service`.
  We follow the same pattern.
- **`EnvironmentFile=/path/to/service/.env`** for per-service secrets
  (twilio-sms). Inline `Environment=` lines for non-secret config
  (wire-bridge uses this heavily). Never both the same var in both places.
- **`WorkingDirectory=`** pointed at the project root (telnyx, twilio).
- **Logging**: twilio-sms is the cleanest example —
  `StandardOutput=journal`, `StandardError=journal`,
  `SyslogIdentifier=twilio-sms`. Others default to journal implicitly.
- **`[Install] WantedBy=default.target`** everywhere (user-systemd convention).
- **No security hardening blocks** (ProtectSystem, NoNewPrivileges, etc.).
  twilio-sms has the comment `# Security hardening` with nothing under it.
  We do not need to introduce new hardening unilaterally — match the house.
- **Timers** (`bot-poller.timer`, `health-watchdog.timer`) are used for
  *periodic oneshots*, not for keeping long-lived daemons warm. `Type=oneshot`
  in the paired service. This is the pattern for our project-level
  heartbeat task runner — NOT the bridge daemon itself.

Deviation from house style we adopt: `Restart=on-failure` instead of
`Restart=always`. Reason: the bridge's daemon has its own supervisor for
the Claude Code child; if the parent exits 0 we want that to mean
"intentional shutdown, don't bounce." All the gateway/webhook services
use `always` because any exit is abnormal for them.

---

## 2. What "heartbeat" means here + our keepalive strategy

**Source of truth:** `~/.openclaw/workspace/agents/heartbeat.md` (`HEARTBEAT.md`
in the workspace root is just a template that says "keep this file empty to
skip heartbeat API calls").

"Heartbeat" in this project is **NOT a systemd watchdog and NOT a TCP
keepalive.** It's a periodic *agent loop*: a list of LLM-executable tasks
(lead-inbox check, port scan, taskrunner `next`, pipeline continuation,
memory review, weekly report) that get run every N minutes by an external
scheduler. The workspace `HEARTBEAT.md` template literally says:

> Keep this file empty (or with only comments) to skip heartbeat API calls.

So "heartbeat" = "things an LLM should do on its periodic tick." It is a
scheduled *workload*, not a liveness ping. There is also a separate
`health-watchdog.service` + timer which runs every few minutes and does
cheap shell-level port checks — that's the liveness pattern, kept
deliberately apart from the LLM loop.

**Implication for cc-telegram-bridge:**

1. The bridge daemon does not need `WatchdogSec=` / sd_notify. Nothing in
   the codebase uses it; introducing it here would be a one-off.
2. The bridge daemon should not "heartbeat" in the LLM sense. That's the
   job of taskrunner / agents/heartbeat.md, not of a transport daemon.
3. What the bridge *does* need is: (a) keep the `claude` child alive
   indefinitely, (b) let external health probes verify the child is
   still responsive, (c) never spend tokens just to prove it's alive.

**Keepalive strategy (chosen):** **process-level supervision + HTTP /health,
zero model calls on the warm path.**

- The daemon spawns `claude` once with `--output-format stream-json
  --input-format stream-json` and holds the stdio pipes open.
- A small in-process supervisor watches: child PID alive
  (`kill -0`), stdin writable, stdout not in EOF, last parser-frame
  timestamp. If any of those fail → respawn the child, do not exit
  the parent.
- `GET /health` on `BRIDGE_HEALTH_PORT` returns
  `{ok, child_pid, child_uptime_sec, last_frame_age_sec, queue_depth}`.
  This is the probe `restart-cc-bridge.sh` and any external monitor calls.
  It does **not** send a message to Claude.
- **Rejected alternatives:**
  - *Periodic no-op prompt* (e.g. send "ping" every 5 min): burns OAuth
    quota, pollutes transcripts, interleaves with real user turns.
  - *Keepalive envelope in stream-json*: no such frame exists in
    Claude Code's stream-json protocol; inventing one would desync the
    parser.
  - *sd_notify WATCHDOG=1*: would work but no other unit on the host uses
    it. Adds novel complexity for no gain over `Restart=on-failure`.
  - *Socket ping to child*: Claude Code has no admin socket; the only
    stdio channel is the turn protocol. Anything we send costs a turn.

The only thing that "keeps the session warm" is the fact that stdio stays
open. As long as the child process is alive and its pipes are connected,
Claude Code holds the session. No tokens needed.

---

## 3. Secrets plumbing

**What the bridge actually needs in `.env`:**

| Var | Source | Why |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | vault | outbound Telegram API |
| `TELEGRAM_ALLOWED_CHAT_IDS` | inline `Environment=` (not a secret) | auth allowlist |
| `OPENCLAW_GATEWAY_URL` | inline `Environment=` | already public |
| `BRIDGE_HEALTH_PORT` | inline `Environment=` | non-secret |
| *(nothing else)* | | |

**What the bridge explicitly does NOT need:**

- **`ANTHROPIC_API_KEY`** — Claude Code uses OAuth from
  `~/.claude/.credentials.json` ($0, Max subscription). Per the workspace
  CLAUDE.md: *"Must unset ANTHROPIC_API_KEY when using Claude Code OAuth
  (it takes priority over OAuth if set)."* The unit file sets
  `Environment=ANTHROPIC_API_KEY=` to actively clear any inherited value.
  `restart-cc-bridge.sh` aborts if it finds the key set in `.env`.
- OpenAI / OpenRouter / any model keys — bridge is transport only.
- SSH / vault master password.

**Steps for G to run** (do NOT run these yourself — ops is read-only):

1. Add the Telegram bot token to the vault:

   ```bash
   # Interactive - KeePassXC prompts for master password
   keepassxc-cli add -p ~/.openclaw/vault.kdbx "cc-telegram-bridge/TELEGRAM_BOT_TOKEN"
   ```

2. Append the entry to `config/secrets-manifest.yaml` under a new
   `cc-telegram-bridge` service block:

   ```yaml
   cc-telegram-bridge:
     env_file: ~/projects/cc-telegram-bridge/.env
     secrets:
       - var: TELEGRAM_BOT_TOKEN
         vault_path: cc-telegram-bridge/TELEGRAM_BOT_TOKEN
         vault_attribute: password
   ```

3. Deploy (dry run first):

   ```bash
   bash scripts/secrets-deploy.sh --dry-run --service cc-telegram-bridge
   bash scripts/secrets-deploy.sh --service cc-telegram-bridge
   ```

4. Verify the `.env` was written and has **no** `ANTHROPIC_API_KEY` line:

   ```bash
   grep -c ANTHROPIC_API_KEY ~/projects/cc-telegram-bridge/.env  # must be 0
   ```

5. Restart via the wrapper (never bare `systemctl`):

   ```bash
   bash ~/projects/cc-telegram-bridge/scripts/restart-cc-bridge.sh "initial deploy"
   ```

Drift detection: `secrets-audit.sh` (already in the workspace) picks up
the new manifest entry automatically on next run.

---

## 4. Observability

**/health endpoint** on `BRIDGE_HEALTH_PORT` (default 18790, one above
`openclaw-gateway`). Shape:

```json
{
  "ok": true,
  "child_pid": 12345,
  "child_uptime_sec": 87234,
  "last_frame_age_sec": 3,
  "queue_depth": 0,
  "version": "cc-telegram-bridge 0.1.0"
}
```

`ok` is `false` if: child PID dead, `last_frame_age_sec > N` while a turn
is in flight, queue depth above cap, or respawn count in the last hour is
over a threshold. HTTP 200 either way — callers inspect `ok`.

**Log format**: single-line, journal-friendly, space-separated
`key=value` pairs (grep-able, not JSON — matches the rest of the house):

```
lvl=info evt=tg.msg.in chat=123 user=g bytes=42
lvl=info evt=claude.turn.start turn=7f3
lvl=warn evt=claude.respawn reason=stdout_eof pid=12345 lifetime_sec=3601
```

**Log sinks**: journal only. `StandardOutput=journal`,
`SyslogIdentifier=cc-telegram-bridge`. No file log — rotation already
handled by journald.

**Check commands (for runbook):**

```bash
# status
systemctl --user status cc-telegram-bridge

# tail live
journalctl --user -u cc-telegram-bridge -f

# last 200 lines, find respawns
journalctl --user -u cc-telegram-bridge -n 200 --no-pager | grep respawn

# health
curl -s 127.0.0.1:18790/health | jq
```

Hook into the existing `health-watchdog.sh` scan: add a port check for
`18790` alongside the existing `18789` (gateway), `8443` (SMS), etc. One
line in the watchdog's port list; it alerts via the same Telegram channel
as the rest.

---

## 5. Rollout discipline

**Parallel to `restart-gateway.sh`**: yes, with the same shape — validate,
backup, restart, health-check, rollback. Drafted at
`/tmp/muxxin-demo/app/deploy/restart-cc-bridge.sh`. Differences from the
gateway script:

- Validates `.env` instead of `openclaw.json` (bridge has no equivalent
  JSON config).
- Hard-aborts if `ANTHROPIC_API_KEY` is set in `.env` — Claude Code OAuth
  would silently break and the daemon would fail mid-turn.
- Uses HTTP `/health` probe instead of `openclaw gateway status`.

**Install checklist for G** (again, ops does not execute):

1. Land the repo at `~/projects/cc-telegram-bridge/`.
2. `scripts/secrets-deploy.sh --service cc-telegram-bridge` (see §3).
3. Copy the unit file:
   `cp deploy/cc-telegram-bridge.service ~/.config/systemd/user/`
4. `systemctl --user daemon-reload`
5. `systemctl --user enable cc-telegram-bridge`
6. `bash scripts/restart-cc-bridge.sh "initial deploy"`
7. Confirm: `curl -s 127.0.0.1:18790/health | jq` shows `ok: true`.
8. Tail for 60s to catch early crashes:
   `journalctl --user -u cc-telegram-bridge -f`

**Never** `systemctl --user restart cc-telegram-bridge` bare — the wrapper
enforces the .env-validation gate that prevents the ANTHROPIC_API_KEY foot-gun.

**Deliverables produced by this plan:**

- `/tmp/muxxin-demo/app/deploy/cc-telegram-bridge.service`
- `/tmp/muxxin-demo/app/deploy/restart-cc-bridge.sh`
- This document.
