# OpenClaw ↔ Claude Code Bridge — Agent Contract

**Author:** backend · **Date:** 2026-04-10 · **Scope:** read-only scouting + docs fetch.
**Goal:** plug a persistent Claude Code session into OpenClaw as a Telegram-facing agent backend without touching live config.

## Section 1 — OpenClaw agent/channel model (as observed)

Sources: `/home/openclaw/.openclaw/openclaw.json` (read-only) and
`https://docs.openclaw.ai/gateway/configuration-reference`.

### 1.1 Routing pipeline

```
telegram event  →  bindings[]  →  agents.list[]  →  model backend
```

The channel never names an agent — it only produces events. Routing is
entirely `bindings[]`'s job.

### 1.2 `channels.telegram` (lines 733–778)

Observed fields: `enabled` (744), `dmPolicy` (745), `allowFrom[]` (752),
`groupPolicy` (755), `execApprovals{}` (737–743), `accounts{}` (757–777,
multi-bot with per-account `botToken`/`dmPolicy`/`allowFrom`), and
`defaultAccount` (777). `streaming: "off"` (line 756) — matters for §3.

### 1.3 `bindings[]` (lines 570–692) — the routing table

```json
{
  "agentId": "priority-groups",
  "match": {
    "channel": "telegram",
    "accountId": "pv-fund",
    "peer": { "kind": "group", "id": "-5098876375" }
  }
}
```

Observed `peer.kind`: `dm`, `group`. Wildcard `id: "*"` works for
catch-alls (655–691). Docs resolution order:
`peer → guildId → teamId → accountId → default agent`. Order matters —
more-specific rules appear first. Docs also mention `type: "route"`
(default) or `type: "acp"`; live config uses only `route`.

### 1.4 `agents.list[]` (lines 256–515) — schema

Observed fields: `id` (required), `default` (bool, one agent gets the
catch-all, e.g. `priority-groups` line 283), `name`, `workspace` (per-
agent CWD), `model: { primary, fallbacks[] }`, `tools: { profile, allow[],
deny[], exec{} }` with `profile` ∈ `coding`/`minimal`, `heartbeat{}`
(318–331).

Per docs, additional valid fields exist but are NOT used live: `agentDir`,
`thinkingDefault`, `reasoningDefault`, `fastModeDefault`, `params`,
`skills`, `identity{}`, `groupChat{}`, `sandbox{}`,
**`runtime{ type, acp{} }`**, `subagents{}`. `runtime` is the only
documented hook for non-stock execution — and its only documented
`type` value is `"acp"`. **No `webhook`, `http`, or `exec` agent-type
exists in the reference.** The plug-in point for non-stock backends
lives one level deeper: `models.providers` or `cliBackends`.

### 1.5 `agents.defaults` (lines 145–255)

- `defaults.model.primary = "claude-cli/sonnet-4.5"` (147) —
  `<backend>/<model>` form.
- `defaults.models{}` (160–197) — alias table; only `alias` is a valid
  sub-key per docs.
- `defaults.cliBackends` (250–254):
  ```json
  "cliBackends": { "claude-cli": { "command": "/home/openclaw/.local/bin/claude" } }
  ```
  Docs say a CLI backend accepts: `command`, `args[]`, `output` (`"json"`),
  `modelArg`, `sessionArg`, `sessionMode` (`"existing"`), `systemPromptArg`,
  `systemPromptWhen` (`"first"`), `imageArg`, `imageMode` (`"repeat"`).
  **Docs flag:** "CLI backends are text-first; **tools are always
  disabled**." Matters for §2.
- Other cross-cutting: `contextTokens`, `compaction`, `memorySearch`,
  `subagents`, `contextPruning`.

### 1.6 `models.providers{}` (lines 50–143) — the HTTP plug-in point

Each provider is an OpenAI-ish upstream. Shape (from the live `deepinfra`
entry):

```json
"deepinfra": {
  "baseUrl": "https://api.deepinfra.com/v1/openai",
  "apiKey": "…",
  "api": "openai-completions",
  "models": [ { "id": "Qwen/…", "contextWindow": 131072, … } ]
}
```

Docs confirm valid `api` values: `openai-completions`, `openai-responses`,
`anthropic-messages`, `google-generative-ai`. Extras: `authHeader` (bool),
`headers{}`. **Crucially, the docs explicitly show
`"baseUrl": "http://localhost:4000/v1"` as a working example.** An
OpenAI-compatible localhost daemon is a first-class supported provider.
That is our plug-in point.

### 1.7 ACP (lines 864–884)

```json
"plugins.acpx": { "enabled": true, "config": { "permissionMode": "approve-all" } }
"acp": {
  "enabled": true, "dispatch": { "enabled": true },
  "backend": "acpx", "defaultAgent": "claude",
  "allowedAgents": ["claude", "codex", "gemini"]
}
```

Docs expose `runtime.type: "acp"` on agents and `bindings[].type: "acp"`,
with nested `acp: { agent, backend, mode, cwd }`. Only documented
`backend` value: `"acpx"`. Only documented `mode`: `"persistent"`. The
reference treats ACP as "already-known infrastructure" — **no protocol
spec, no wire format, no server-side interface documented.** Risky as a
primary path.

### 1.8 Existing non-stock backends in use

- **`claude-cli`** — live CLI backend, process-per-call wrapper around
  `/home/openclaw/.local/bin/claude`. Tools disabled.
- **`deepseek`/`deepinfra`/`google`** — three OpenAI-compatible HTTP
  providers, proof the provider interface works with arbitrary HTTP
  endpoints.
- **`acpx`** — plugin-enabled, but no agent currently uses
  `runtime.type: "acp"`. Dormant.

No existing webhook/http/exec agent type.

---

## Section 2 — Plug-in points, cleanest-first

### (A) ⭐ **Register the bridge as an OpenAI-compatible model provider**

Add `models.providers.cc-bridge` pointing at our daemon on
`http://127.0.0.1:<port>/v1`, add an agent in `agents.list[]` with
`model.primary = "cc-bridge/<session-id>"`, add a `bindings[]` rule for
the Telegram peers we want routed into Claude Code.

**Why cleanest:**
- Zero gateway patches. Only config edits in the documented schema.
- Uses a documented path (docs literally show `localhost:4000/v1`).
- Works with existing bindings, workspaces, heartbeats, and fallbacks.
  If the bridge is down, the agent's `model.fallbacks[]` degrade to
  `claude-cli/sonnet-4.5` automatically.
- Persistent CC session lives entirely inside the bridge — OpenClaw
  never knows sessions exist. Each HTTP call is stateless from
  OpenClaw's perspective; statefulness is the bridge's problem.
- Fully reversible — delete three config chunks, back to baseline.

**Trade-offs:**
- Must implement a minimal OpenAI Chat Completions surface
  (`/v1/chat/completions`, `/v1/models`). ~150 lines.
- OpenClaw's agent-level `tools` config applies to the model's tool
  output. Since CC runs its own tools internally, set
  `tools.profile: "minimal"` and let CC handle tools. OpenClaw sees
  only final text.
- Streaming: Telegram is `streaming: "off"`. Implement non-streaming.
- Model-id → session-id mapping: encode session in the model string.

**Config shape (draft only — NOT applied):**

```jsonc
"cc-bridge": {
  "baseUrl": "http://127.0.0.1:18901/v1",
  "api": "openai-completions",
  "apiKey": "${CC_BRIDGE_PROVIDER_KEY}",
  "models": [{
    "id": "session-main",
    "name": "Claude Code Bridge (main)",
    "input": ["text"],
    "contextWindow": 200000,
    "maxTokens": 8192
  }]
}

// agents.list[]
{
  "id": "cc-bridge",
  "name": "Claude Code Bridge",
  "workspace": "/home/openclaw/.openclaw/workspace",
  "model": {
    "primary": "cc-bridge/session-main",
    "fallbacks": ["claude-cli/sonnet-4.5"]
  },
  "tools": { "profile": "minimal" }
}

// bindings[] — gated to G's DM as first cut
{
  "agentId": "cc-bridge",
  "match": { "channel": "telegram", "peer": { "kind": "dm", "id": "39172309" } }
}
```

### (B) Register as a new `cliBackends` entry

`cliBackends.cc-bridge` with a `command` that execs a thin client
forwarding stdin/stdout to the persistent daemon over a Unix socket.

**Worse because:** docs say CLI backends disable tools; process-per-call
fork+exec overhead on every message; limited to `modelArg`/`sessionArg`/
`systemPromptArg` flag shapes. Only pursue if (A) is blocked.

### (C) ACP (`runtime.type: "acp"` / `bindings[].type: "acp"`)

Register the bridge as an ACP server; let `acpx` dispatch to it.

**Worse because:** protocol undocumented in the config reference — we'd
reverse-engineer `acpx` to discover wire format, framing, capabilities,
permission model. `allowedAgents: ["claude","codex","gemini"]` may
require patching the acpx plugin, not just config. Upside: the "right"
OpenClaw-native path for persistent stateful agents. Revisit only if
(A) hits a wall.

### (D) Patch the gateway source

`/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/index.js`.

**Ruled out.** CLAUDE.md puts `openclaw.json` edits under a mandatory
gate because the gateway has been bricked four times from config. Patching
the compiled JS of a live service is strictly worse. G will hate it.

---

## Section 3 — Recommended interface (what the bridge exposes)

A small HTTP server shipping the subset of OpenAI Chat Completions that
OpenClaw's `openai-completions` driver actually calls.

### 3.1 Listener

- Bind: `127.0.0.1:18901` (loopback; 18901 is adjacent to gateway 18789).
- TLS: none (loopback only, matches gateway's own `bind: "loopback"`
  on line 793).
- No public exposure. Per CLAUDE.md: never host sensitive material on
  public URLs.

### 3.2 Endpoints

| Method | Path | Priority |
|---|---|---|
| `POST` | `/v1/chat/completions` | **required** |
| `GET`  | `/v1/models` | required-ish (provider probing) |
| `GET`  | `/healthz` | required (our own supervision) |

### 3.3 `POST /v1/chat/completions` — request

OpenClaw sends a standard OpenAI payload. Subset we care about:

```jsonc
{
  "model": "session-main",
  "messages": [
    { "role": "system",    "content": "…agent system prompt…" },
    { "role": "user",      "content": "latest telegram message text" },
    { "role": "assistant", "content": "prior reply" },
    { "role": "user",      "content": "follow-up" }
  ],
  "stream": false,
  "max_tokens": 8192,
  "user": "telegram:39172309"
}
```

**Bridge responsibilities:**
1. Auth: require `Authorization: Bearer <shared-secret>` matching the
   provider's `apiKey`. Reject with `401` otherwise.
2. Parse `model` → session-id. Strip a `cc-bridge/` prefix if OpenClaw
   forwards the full id.
3. Look up (or spawn) the persistent CC session owned by the
   `integration` teammate. Likely Unix socket or named pipe —
   out of scope for this doc.
4. Take the last `user` message as the CC prompt. The system prompt
   only goes into CC's session bootstrap on first contact. Ignore prior
   turns unless the CC session is stateless (then replay).
5. Block until CC produces its final assistant turn. Do NOT stream
   intermediate tool-use events upstream — the provider driver is
   non-streaming in our mode.

### 3.4 `POST /v1/chat/completions` — response

Standard non-streaming envelope:

```jsonc
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "session-main",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "<final CC reply>" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Token counts may be zero-stubs — used for accounting, not correctness.
`finish_reason`: `stop` (normal), `length` (CC hit its cap),
`content_filter` (suppressed).

**Error cases:**

| Condition | HTTP | Body type |
|---|---|---|
| Bad/missing auth | `401` | `authentication_error` |
| Unknown session-id | `404` | `not_found_error` |
| CC session crashed | `503` | `upstream_error` |
| Overloaded | `429` | rate-limit |
| Timeout on CC | `504` | `upstream_error` |

Non-2xx hands off to OpenClaw's `model.fallbacks[]` automatically — we
do NOT implement fallback ourselves.

### 3.5 `GET /v1/models`

```json
{
  "object": "list",
  "data": [
    { "id": "session-main", "object": "model",
      "created": 1760000000, "owned_by": "cc-bridge" }
  ]
}
```

### 3.6 Auth

Shared-secret bearer token. Generate once, store in the vault as
`CC_BRIDGE_PROVIDER_KEY`, deploy via `secrets-deploy.sh` into the
gateway's env, reference from the provider entry as
`"apiKey": "${CC_BRIDGE_PROVIDER_KEY}"`. The bridge's systemd unit reads
the same env var. No rotation tooling in v1 — loopback-only.

### 3.7 Session lifecycle — ownership

- **OpenClaw:** telegram auth, peer matching, agent selection, fallback
  routing, message history for its own agents.
- **Bridge:** auth, session-id → CC-process mapping, CC spawn/restart/
  health, per-session scratch state, decision on history replay.
- **Claude Code:** tool execution, reasoning, file edits, MCP servers,
  its own memory.

OpenClaw's per-agent `workspace` is effectively ignored — CC has its
own CWD. Keep it set to a harmless location so OpenClaw doesn't complain.

### 3.8 Observability

Bridge logs each request: session-id, latency, status, bytes. On 5xx,
log the full OpenClaw request for postmortem. Systemd journal, not
stdout. `/healthz` returns `200` iff the CC session is reachable;
otherwise `503`. Hook into `/tmp/service-health.log`.

---

## Section 4 — Open questions for G

1. **Session granularity.** One persistent CC session per Telegram peer
   or one shared across bridged traffic? Per-peer gives continuity but
   multiplies cost and mixes nothing. Shared is cheaper but contexts
   cross — risky for a fixer running parallel counterparty ops.
2. **Which peers get routed?** Today almost all traffic goes to
   `priority-groups` via the catch-all on lines 682–691. A new CC
   binding must go **above** the catch-all. My recommendation for the
   first cut: gate to G's DM only (`telegram` / `dm` / `39172309`).
3. **Tool surface.** CC inside the bridge will be fully tooled because
   it's YOU. OpenClaw's `tools.elevated.allowFrom.telegram: ["39172309"]`
   (537–544) becomes irrelevant on the CC side — the bridge only sees
   text. Acceptable, or inject an "is this G?" flag into CC's system
   prompt so CC gates destructive actions itself?
4. **Fallback loudness.** On bridge 5xx, `model.fallbacks[]` will
   silently roll over to `claude-cli/sonnet-4.5` — G might get a reply
   from the "normal" stack instead of the persistent CC session.
   Acceptable, or should the bridge degrade loudly with
   `"cc-bridge unavailable, retry"`?
5. **ACP scouting spike?** Worth a parallel spike on the ACP protocol?
   It's the "right" OpenClaw-native way but docs are silent. Knowing
   that cost up front lets us pick deliberately instead of defaulting
   to the provider path because it's documented.
6. **Streaming.** Telegram is `streaming: "off"` today. If you ever
   want token-by-token streaming, the bridge must speak SSE — skip
   for now, flag as v2.
7. **Deploy path.** Once (A) is approved, the config edit MUST go
   through `scripts/config-edit-safe.sh` per CLAUDE.md. Three schema-
   validated writes: one provider, one agent, one binding. Happy to
   draft; NOT applying without explicit green light.

---

**Recommendation:** Approach (A) — the OpenAI-compatible provider. One
daemon, three config edits, fully reversible, uses documented paths
only, degrades cleanly via OpenClaw's built-in fallback chain.
