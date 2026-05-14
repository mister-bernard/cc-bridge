# cc-bridge

Persistent [Claude Code](https://claude.com/claude-code) sessions exposed
as an OpenAI-compatible `/v1/chat/completions` endpoint, so any client that
speaks the OpenAI API (gateways, chat UIs, Telegram/Signal bots, cron jobs)
can talk to a long-running Claude Code agent that **remembers context**
across turns, channels, and process restarts.

```
   ┌──────────────────────┐    POST /v1/chat/completions    ┌────────────────────┐
   │ OpenAI-compatible    │ ──────────────────────────────▶ │   cc-bridge        │
   │   client / gateway   │ ◀────── stream-json reply ───── │   (this repo)      │
   └──────────────────────┘                                 └─────────┬──────────┘
                                                                      │  spawn / -p
                                                                      ▼
                                                            ┌────────────────────┐
                                                            │  claude (CLI)      │
                                                            │  one persistent    │
                                                            │  process per       │
                                                            │  session-id        │
                                                            └────────────────────┘
```

## Why

Claude Code is a powerful CLI agent — but `claude -p` exits after one turn.
For a Telegram bot, an oncall responder, or any long-running surface, you
need the same Claude *session* to handle many turns over hours or days, with
file-based memory that survives restarts. cc-bridge is the supervisor:
one persistent `claude` child per session id, an OpenAI-shaped HTTP
endpoint in front, and a JSONL convo log behind so context survives
idle-timeout sweeps and SIGKILLs.

## Features

- **Persistent sessions.** Same `model` (= session id) on subsequent
  requests reuses the same `claude` process. Memory in process; convo
  log on disk for free recovery after restarts.
- **OpenAI-compatible.** `/v1/models`, `/v1/chat/completions`, bearer
  auth — works with anything that speaks chat-completions.
- **Per-session config.** Models, idle timeouts, working directories,
  stateless mode, extra CLI args — all per-session via env-var JSON maps.
- **Public-facing hardening.** Optional shared "common-public" prompt
  block prepended to designated sessions; `--disallowedTools` defense in
  depth on group sessions.
- **Boot notifications.** Optional Telegram "spinning up..." while a
  cold session warms; auto-deleted on first response.
- **Stream-aware.** Server-Sent Events with real `chat.completion.chunk`
  keep-alives; surfaces upstream errors as SSE error chunks.

## Requirements

- Node ≥ 18
- A Claude Code install (`claude` on `$PATH`). Sign in with `claude` so
  OAuth credentials are at `~/.claude/.credentials.json` — cc-bridge
  reuses them and keeps `ANTHROPIC_API_KEY` empty.

## Setup

```bash
git clone https://github.com/mister-bernard/cc-bridge.git
cd cc-bridge

cp .env.example .env

# Edit .env at minimum:
#   CC_BRIDGE_PROVIDER_KEY    bearer your gateway will present
#   CLAUDE_BIN                path to your installed `claude` (which claude)
#   BRIDGE_PORT               port to listen on (default 18901)

node src/daemon.js          # foreground
```

The daemon auto-creates the conversation log directory and (if needed) a
`session-state.json` index. Personal/identity prompts live in
`prompts/<session-id>.txt`. The bridge resolves prompts in this order:

  1. `systemPrompt` constructor override (test-only).
  2. `CC_BRIDGE_SYSTEM_PROMPT` env var (single-session deploys).
  3. `prompts/<session-id>.txt`
  4. `prompts/default.txt`
  5. Empty.

If a session id is also listed in `CC_BRIDGE_PUBLIC_SESSIONS`, the file
`prompts/_common-public.txt` (if present) is prepended automatically.

See `prompts/session-default.example.txt` and
`prompts/_common-public.example.txt` for templates.

## systemd (long-running)

```bash
sed "s|@CC_BRIDGE_DIR@|$PWD|g" deploy/cc-bridge.service \
  > ~/.config/systemd/user/cc-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now cc-bridge
```

For safe restarts (validates `.env`, backs up, probes `/health`, rolls
back on failure):

```bash
bash deploy/restart-cc-bridge.sh "reason for restart"
```

## HTTP API

| Method | Path                       | Auth     | Purpose                                   |
| ------ | -------------------------- | -------- | ----------------------------------------- |
| GET    | `/healthz` (or `/health`)  | none     | Status + supervisor stats                 |
| GET    | `/v1/models`               | bearer   | List configured session ids               |
| POST   | `/v1/chat/completions`     | bearer   | One turn against a session                |

The OpenAI `model` field is parsed as `[<prefix>/]<session-id>` — any
session id lazy-spawns its own supervisor on first use. Streaming is
supported (`stream: true`); SSE error chunks surface upstream errors
without silent `[DONE]`.

## Outbound Telegram from a session

When a session needs to send a Telegram message back to the operator
(boot notifications, completion alerts, scheduled updates), use
`bin/tg-send.sh`:

```bash
bin/tg-send.sh "build finished cleanly"
bin/tg-send.sh --chat -1001234567890 "group ping"
echo "from a pipe" | bin/tg-send.sh
```

It delegates to a canonical sender (typically [telegraph](
https://github.com/mister-bernard/telegraph)'s `tg-send-logged.sh`) that
handles outbox logging + origin registration so the user's reply routes
back to **this** session instead of a static fallback. Configure via
`CC_BRIDGE_TG_SEND_CANONICAL` and `CC_BRIDGE_TG_DEFAULT_CHAT` in `.env`.

## Tests

```bash
npm test                              # unit + security suites
node tests/smoke/live-single-turn.mjs # one real turn against `claude`
node tests/smoke/live-multi-turn.mjs  # multi-turn memory in one process
node tests/smoke/live-daemon.mjs      # full daemon end-to-end
```

Smoke tests require a working `claude` install and burn real OAuth turns.

## License

MIT.
