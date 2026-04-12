# OpenClaw Gateway — Telegram → Agent Dispatch, Extension Points, and Bridge Integration Plan

Scouting report for the `cc-telegram-bridge` team. Read-only; no files in
`.npm-global` were touched.

Package root: `/home/openclaw/.npm-global/lib/node_modules/openclaw/`
Gateway bin: `node openclaw.mjs` → `dist/entry.js` (see `openclaw.mjs:173`)
Gateway port in config: `18789` (`~/.openclaw/openclaw.json:791`)
**Note:** The gateway was NOT listening on 18789 during this scout
(`ss -tlnp` shows 18800/18801/18810 owned by unrelated services). All
HTTP-surface claims below are from docs, not live probes.

---

## 1. Gateway structure

```
openclaw/
├── openclaw.mjs               # Node entry + version gate → dist/entry.js
├── package.json               # npm manifest (bundled version, deps)
├── dist/
│   ├── entry.js               # main gateway entry
│   ├── <thousands of chunked .js>   # rolled-up bundles (hash-suffixed)
│   ├── extensions/            # bundled plugins (first-party)
│   │   ├── anthropic/         #   claude-cli backend is registered here
│   │   ├── telegram/          #   telegram channel plugin
│   │   ├── acpx/              #   ACP dispatch to claude/codex/gemini
│   │   ├── signal/, slack/, discord/, ...  # other channel plugins
│   │   └── openai/, google/, deepseek/, ...# other provider plugins
│   └── agents/                # built-in agent runtime helpers
├── docs/                      # full doc tree (source of truth below)
│   ├── plugins/               #   SDK reference + plugin guides
│   ├── gateway/               #   gateway HTTP/config/CLI docs
│   └── channels/              #   per-channel routing docs
└── node_modules/              # vendored deps (telegraf, @grammyjs, ...)
```

Key takeaways:
- Built-in channels, providers, and CLI backends are implemented as **the
  same plugin shape** an external plugin would use. No hidden internal hook —
  telegram is just `defineChannelPluginEntry({ id: "telegram", plugin: ... })`.
- The Telegram channel bundle internally uses **grammy** (not telegraf), even
  though both `telegraf` and `@grammyjs/*` are vendored. grammy is at
  `dist/extensions/telegram/node_modules/grammy/`.
- The SDK surface is stable and advertised in `docs/plugins/sdk-overview.md`
  with 100+ subpath imports (`openclaw/plugin-sdk/<subpath>`).

---

## 2. Telegram → agent dispatch flow

Traced through bundled source (hash-suffixed filenames are stable per
install; line numbers refer to this install of the package).

1. **Plugin entry registers the channel.**
   `dist/extensions/telegram/index.js:4` calls
   `defineChannelPluginEntry({ id: "telegram", name: "Telegram",
   plugin: telegramPlugin, setRuntime: setTelegramRuntime })`. `telegramPlugin`
   and `setTelegramRuntime` are imported from the rolled-up channel bundle
   `dist/channel-BIiK00F1.js:2`.

2. **Channel plugin is built on the generic chat channel base.**
   `dist/channel-BIiK00F1.js:9` imports `createChatChannelPlugin` from
   `core-BghMcc08.js`. `channel-BIiK00F1.js` wires Telegram-specific helpers
   into that base:
   - `sendMessageTelegram`, `sendTypingTelegram` (outbound) — from
     `sticker-cache-Cf0p9p0n.js` (imported at line 30)
   - `monitorTelegramProvider` (the grammy-based poller that reads updates
     and emits inbound envelopes) — from `monitor-BDByGBM-.js` (line 31)
   - `resolveTelegramSessionConversation` — from
     `session-conversation-8H5Rvqnl.js` (line 32)
   - `resolveThreadSessionKeys`, `buildOutboundBaseSessionKey` for session
     keying — from `session-key-D7XpmyVq.js` / `base-session-key-BM8QSZQb.js`
   - `probeTelegram`, approval capability wiring, group-policy checks.

3. **Inbound update → envelope → route → agent.**
   The grammy runner hands updates to the channel base pipeline. From the
   SDK subpath map in `docs/plugins/sdk-overview.md:47-64`
   (`channel-inbound`, `channel-targets`, `channel-contract`,
   `channel-reply-pipeline`), the generic pipeline:
   1. normalises the raw update into a channel-agnostic envelope
      (`channel-inbound` helpers), applying debounce, mention matching,
      allow-from filtering, and group-policy gating.
   2. resolves a **session key** (`resolveThreadSessionKeys`,
      `session-key-D7XpmyVq.js`).
   3. picks exactly **one agent** via the routing rules in
      `docs/channels/channel-routing.md:60-73`:
      peer match → thread inheritance → guild/team match → account match →
      channel-wildcard match → default agent (`agents.list[].default`).
   4. enters a per-session serialized runner
      (`agent-runner.runtime-DEDCwJ0o.js`, the bundled agent runtime).
   5. the agent's configured model is resolved against providers and CLI
      backends; the inference call returns text; the reply pipeline
      (`channel-reply-pipeline`) sends the reply **back through the same
      Telegram account** that received it.

4. **Claude CLI backend is the current terminal target for most agents.**
   Every agent in `~/.openclaw/openclaw.json` uses `claude-cli/sonnet-4.5`
   as its primary model. The `claude-cli` backend is registered at
   `dist/extensions/anthropic/index.js:245` via
   `api.registerCliBackend(buildAnthropicCliBackend())`. The backend config
   is defined at `dist/cli-backend-B5Vp6f0k.js:4-47` and spawns:
   ```
   claude -p --output-format stream-json --verbose
          --permission-mode bypassPermissions
          --model <alias> --session-id <uuid>
          --append-system-prompt <...>
          <prompt>
   ```
   That is the exact process boundary the gateway already crosses to "talk
   to Claude Code." Our bridge can slot into the same boundary.

5. **ACP dispatch path also exists** (`dist/extensions/acpx/`). Config at
   `~/.openclaw/openclaw.json:872-884` has `acp.enabled = true`, `backend:
   "acpx"`, `defaultAgent: "claude"`, `allowedAgents: [claude, codex,
   gemini]`. The `acpx` plugin implements the Agent Client Protocol for
   control-plane-style dispatch — not the same path as channel-inbound
   message handling.

---

## 3. Extension points, ranked cleanest-first

Every option below is a **supported, first-party extension seam**. None
requires patching `.npm-global`.

| # | Surface | What it registers | Source patch needed? | Plugin install needed? |
|---|---|---|---|---|
| 1 | `agents.defaults.cliBackends.<id>` (config-only) | A local CLI backend reachable as `<id>/<model>` model ref | No | No |
| 2 | `api.registerCliBackend(...)` (in a tiny external plugin) | Same backend, plugin-owned defaults | No | Yes (1 plugin) |
| 3 | `api.registerProvider(...)` (external plugin) | An LLM provider (text inference), dynamic-model resolver → HTTP/stdio bridge | No | Yes (1 plugin) |
| 4 | `api.registerHook("before_model_resolve", ...)` or `before_prompt_build` | Intercept per-agent runs and rewrite model/prompt | No | Yes (1 plugin) |
| 5 | `api.registerHttpRoute(...)` + `api.registerGatewayMethod(...)` | Custom gateway HTTP/RPC endpoint on :18789 | No | Yes (1 plugin) |
| 6 | `api.registerChannel(...)` via `defineChannelPluginEntry` | A brand-new inbound channel (irrelevant — we already have Telegram) | No | Yes (1 plugin) |
| 7 | OpenAI-compatible HTTP endpoint `POST /v1/chat/completions` | Agent-target routing from an **external** HTTP caller | No | No |

Notes per option:

- **#1 CLI backend via config.** The absolute minimum. No plugin, no build,
  no npm install, no source patch. The user already has `cliBackends:
  { "claude-cli": { command: "/home/openclaw/.local/bin/claude" } }` at
  `openclaw.json:250`. Adding a second entry `"cc-bridge": { command:
  "/home/openclaw/bin/cc-bridge", args: [...], output: "json", ... }` is
  symmetrical with what already works. The bridge binary just needs to
  behave like a tiny Claude Code CLI (see Section 5).
- **#2 CLI backend via plugin** only matters if we want to ship plugin-owned
  defaults (e.g. ClawHub packaging). Functionally equivalent to #1.
- **#3 Provider plugin.** Strictly more powerful — supports streaming, tool
  calls, dynamic-model routing, cost metadata. Overkill for this task; a
  provider plugin implies registering with `api:
  "openai-completions"` or writing custom stream hooks, plus an
  `openclaw.plugin.json` manifest, plus a package. Worth it only if the
  bridge needs to expose multiple model ids or proper streaming.
- **#4 Hooks.** `before_agent_start` is deprecated (warning) per
  `docs/plugins/architecture.md:87-95`. Prefer `before_model_resolve` /
  `before_prompt_build`. Useful for side-effect mirroring (e.g. also log
  every Telegram→agent run to the bridge) but cannot fully replace
  dispatch.
- **#5 HTTP route inside a plugin.** The gateway has a plugin-registerable
  HTTP surface on port 18789. Fine if we want an **outbound** webhook
  surface (bridge pushes something into the gateway), but not needed if
  dispatch goes through a CLI backend.
- **#6 Channel plugin.** Not useful — we don't need OpenClaw to treat the
  bridge as a separate inbound channel. Telegram is already the inbound
  channel.
- **#7 OpenAI HTTP endpoint.** Already enabled in this install
  (`openclaw.json:802-808`: `gateway.http.endpoints.chatCompletions.enabled
  = true`). This is **incoming** — something outside the gateway calls it
  and the gateway runs an agent. It is the cleanest way for the
  **bridge** to push text into OpenClaw, not for OpenClaw to push text into
  the bridge.

---

## 4. HTTP API surface on port 18789

Gateway was not running during the scout so endpoints are documented, not
probed. Source of truth: `docs/gateway/openai-http-api.md`,
`docs/gateway/tools-invoke-http-api.md`, `docs/gateway/bridge-protocol.md`.

Auth: `Authorization: Bearer <gateway.auth.token>`. Current token lives at
`openclaw.json:796`. Treat it as operator-level — the OpenAI endpoint
runs agents in trusted-operator mode regardless of narrower scope headers
(`openai-http-api.md:38-49`).

| Method | Path | Notes |
|---|---|---|
| GET  | `/v1/models`                    | Returns `openclaw`, `openclaw/default`, `openclaw/<agentId>` targets (agents, not provider models) |
| GET  | `/v1/models/{id}`               | Single target lookup |
| POST | `/v1/chat/completions`          | OpenAI-compatible; `model: "openclaw/<agentId>"` routes to a specific agent; `stream: true` returns SSE |
| POST | `/v1/responses`                 | OpenAI Responses API (agent-native) |
| POST | `/v1/embeddings`                | Routes through the selected agent's embedding setup |
| GET  | `/health`                       | (Mentioned in `docs/gateway/health.md` — not verified live) |
| —    | WebSocket upgrade on same port  | Gateway protocol for control/session traffic (`docs/gateway/protocol.md`, `bridge-protocol.md`) |

Useful headers on the OpenAI endpoint:
- `x-openclaw-agent-id: <agentId>` — override the routed agent
- `x-openclaw-model: <provider/model>` — override the backend model for
  that agent
- `x-openclaw-session-key: <key>` — pin to a specific session store
- `x-openclaw-message-channel: <channel>` — synthetic ingress channel
  label for channel-aware prompts / policies

Quick smoke (once the gateway is running):
```bash
curl -sS http://127.0.0.1:18789/v1/models \
  -H "Authorization: Bearer $(jq -r .gateway.auth.token ~/.openclaw/openclaw.json)"
```

---

## 5. Recommended integration — smallest clean intervention

**Use a CLI backend, bound to a dedicated bridge-agent, pinned to a
specific Telegram peer/account via `bindings[]`.** No plugin, no npm
install, no source patch, no custom HTTP listener.

### Why this is the right call
- It reuses the **exact same execution boundary** OpenClaw already crosses
  for `claude-cli/*` today (`cli-backend-B5Vp6f0k.js`). The code path is
  battle-tested.
- It works at the **agent** layer, so routing, session storage, reply
  pipeline, approval flows, streaming fallback, and audit are all
  handled by OpenClaw for free.
- It is **config-only** on the OpenClaw side. The bridge team owns a
  single binary with a small CLI contract. If the binary is missing or
  broken, OpenClaw's existing fallback list in `agents.defaults.model`
  degrades gracefully.
- It can coexist with the current `claude-cli` backend; nothing existing
  changes.

### The three-step wiring (all inside `~/.openclaw/openclaw.json`)

1. **Register the backend** (add under
   `agents.defaults.cliBackends`):
   ```json5
   "cc-bridge": {
     "command": "/home/openclaw/bin/cc-bridge",
     "args": ["--output", "json"],
     "output": "json",
     "input": "stdin",
     "modelArg": "--model",
     "sessionArg": "--session-id",
     "sessionMode": "always",
     "systemPromptArg": "--system",
     "systemPromptWhen": "first"
   }
   ```
   The keys are exactly those documented in
   `docs/gateway/cli-backends.md:107-138`. No invented keys.

2. **Register a bridge agent** (add to `agents.list[]`):
   ```json5
   {
     "id": "cc-bridge",
     "name": "CC Team Bridge",
     "workspace": "/home/openclaw/.openclaw/workspace",
     "model": {
       "primary": "cc-bridge/default",
       "fallbacks": ["claude-cli/sonnet-4.5"]
     },
     "tools": { "profile": "minimal" }
   }
   ```
   The fallback is critical — if the bridge is down, Telegram messages
   still get answered by the existing claude-cli backend.

3. **Route specific Telegram peers to it** (add top-level `bindings[]`,
   per `docs/channels/channel-routing.md:98-110`):
   ```json5
   "bindings": [
     { "match": { "channel": "telegram", "peer": { "kind": "user", "id": "39172309" } },
       "agentId": "cc-bridge" }
   ]
   ```
   Scope can be tightened to a single group/topic or widened to
   `accountId: "*"` for an entire bot token.

### The bridge binary contract

A ~50-line wrapper script. Receives:
- Prompt on **stdin** (because `input: "stdin"`).
- `--model <alias>` — ignore or log.
- `--session-id <uuid>` — a stable id per conversation; use it as the
  `SendMessage` thread key into the cc team lead.
- `--system <text>` — system prompt on first turn; optional.

Must emit a single JSON object on stdout (because `output: "json"`),
shaped like:
```json
{ "text": "<assistant reply>", "session_id": "<echo input>" }
```
The parser in `cli-backend-B5Vp6f0k.js` pulls `text` from known keys and
`session_id` from `sessionIdFields` (`CLAUDE_CLI_SESSION_ID_FIELDS`; the
default includes `session_id`, so no override needed).

Internally the bridge binary:
1. Opens/attaches to the `cc` tmux team session for that `session-id`.
2. Sends the prompt to the team lead via `SendMessage` (or the `cc`
   CLI equivalent).
3. Waits for the lead's final reply.
4. Prints the JSON object and exits 0.

That's it. No source patching, no plugin build, no gateway restart
semantics beyond the normal one we take for any config edit (which we do
via `bash scripts/config-edit-safe.sh` per CLAUDE.md).

### Config-gate checklist (per CLAUDE.md rules)

Before editing `openclaw.json`:
1. `web_fetch("https://docs.openclaw.ai/gateway/configuration-reference")`
   and confirm `agents.defaults.cliBackends.<id>`, `agents.list[]`, and
   top-level `bindings[]` keys exist and match the shapes above.
2. Edit with `scripts/config-edit-safe.sh` (or equivalent) — **never** by
   hand in the same pass that restarts the gateway.
3. Run `openclaw doctor` (read-only) — **never** `--fix`.
4. Restart only via `scripts/restart-gateway.sh "add cc-bridge backend"`.

### If a plugin is later required

Only upgrade to a real plugin (option #2 or #3 in Section 3) if we need:
- **Streaming** of tokens back to Telegram (CLI backends buffer by
  design — see `cli-backends.md:233-237`).
- **Tool calls** routed through OpenClaw tool policy (CLI backends are
  text-only).
- **Plugin-owned defaults** on ClawHub or npm.

For all other "just get Telegram messages into the cc team" goals, the
CLI-backend path wins on every axis.

---

## Appendix — files referenced

- `openclaw.mjs:173` — entry wrapper → `dist/entry.js`
- `dist/extensions/telegram/index.js:4` — telegram plugin entry
- `dist/channel-BIiK00F1.js:9,24-34` — telegram plugin wiring on top of
  `createChatChannelPlugin`
- `dist/extensions/anthropic/index.js:245` — `registerCliBackend` call
- `dist/cli-backend-B5Vp6f0k.js:4-47` — `buildAnthropicCliBackend()`
  config (the template for our `cc-bridge` backend config)
- `docs/plugins/sdk-overview.md` — registration API + subpath map
- `docs/plugins/building-plugins.md` — plugin quick-start + capabilities
  table
- `docs/plugins/sdk-provider-plugins.md` — provider plugin walkthrough
- `docs/plugins/sdk-entrypoints.md` — entry-point helpers + registration
  modes
- `docs/plugins/architecture.md:87-95` — legacy hook deprecation guidance
- `docs/gateway/cli-backends.md` — CLI backend schema and defaults
- `docs/gateway/openai-http-api.md` — HTTP API on :18789
- `docs/channels/channel-routing.md:60-110` — routing rules and
  `bindings[]` schema
- `~/.openclaw/openclaw.json:144-255,732-884` — current agents, channels,
  gateway, plugins, acp config
