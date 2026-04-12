# ACP Scouting Report

## Verdict

**Not viable as a third-party plugin point.** ACP dispatch in OpenClaw is hardcoded to a whitelist of known agents and provides no server-side interface or protocol documentation for third-party backends. The `allowedAgents` list cannot be extended beyond the bundled four without patching the acpx plugin source.

---

## Evidence

### Q1: Is `allowedAgents` hardcoded or config-driven?

**Answer: Hardcoded allowlist.** The config value exists and is checked, but the validation logic (line 21210 in `pi-embedded-BYdcxQ5A.js`) treats an empty list as "allow all," not "allow user-extended." The acpx plugin itself uses `ACPX_BUILTIN_AGENT_COMMANDS` (line 859–874 in `extensions/acpx/index.js`) — a literal object with six hardcoded entries: `pi`, `openclaw`, `codex`, `claude`, `gemini`, `cursor`, `copilot`, `droid`, `iflow`, `kilocode`, `kimi`, `kiro`, `opencode`, `qwen`.

Critically, `resolveAcpxAgentCommand()` (line 917–925) first tries to load overrides from `acpx config show`, then falls back to the builtin table. The config *can* add an override, but only for agents in acpx's own config file (`~/.acpx/config.json`), not OpenClaw's `openclaw.json`.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/pi-embedded-BYdcxQ5A.js:21210`, `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/index.js:859–874`

---

### Q2: Wire format?

**Answer: Line-delimited JSON (NDJSON) over stdout/stderr.** The acpx plugin spawns an ACP agent as a subprocess (e.g., `npx -y @zed-industries/claude-agent-acp@0.21.0` for `claude`) and sends prompts to its stdin. The agent responds with JSON lines on stdout. `parseJsonLines()` (line 646–655) splits on `\r?\n`, then parses each non-empty line as a JSON object against `AcpxJsonObjectSchema`. No framing, no length prefixes—just line breaks.

Response envelope includes fields like `type` (`text`, `thought`, `tool_call`, `usage_update`, `done`, `error`), `content` or nested `update`, and metadata. The runtime streams these back to the gateway.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/index.js:306–323` (stdin write), `646–655` (parse), `1384–1451` (recv loop with readline)

---

### Q3: Server-side interface for third-party backends?

**Answer: None.** ACP agents are spawned as subprocesses, not called as servers. The acpx plugin invokes `spawn(resolved.command, resolved.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })` (line 313–323). Stdin is the channel for prompts (JSON stringified request blocks); stdout is NDJSON events; stderr is diagnostics. The subprocess must exit cleanly after each turn (or manage state across turns via named sessions—that's acpx's job, not the plugin's).

There is no socket, no handshake, no "register as backend" contract. A third-party binary cannot hook into OpenClaw's ACP dispatch without being in the builtin agent table or acpx's config.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/index.js:313–323`, `917–925`

---

### Q4: Persistent sessions?

**Answer: Yes, natively.** acpx manages persistent sessions with `acpx codex sessions new --name <id>` and `sessions ensure --name <id>`. The runtime state (including agent process pid and queue owner metadata) persists under `~/.acpx/sessions/`. The same acpx invocation can reuse a session across multiple prompts (lines 1270–1359 show `ensureSession` logic). A single agent process can survive multiple turns if the underlying agent supports it.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/index.js:1105–1360` (`ensureSession`, `createNamedSession`, session resurrection on dead pid)

---

### Q5: Streaming support?

**Answer: Yes.** The acpx plugin reads from stdout line-by-line in a readline loop (line 1410) and yields parsed events immediately (line 1420). Each event can be a `text_delta`, `tool_call`, `status`, `usage_update`, `error`, or `done`. The gateway's reply pipeline then streams these back to the channel (see `AcpStreamConfig` in `types.acp.d.ts` for coalesce/delivery modes).

Frame type: plain JSON objects, one per line. No chunking or trailer-delimited framing needed.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/index.js:1410–1451`, `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/src/config/types.acp.d.ts:6–26`

---

### Q6: Permission model?

**Answer: Three modes, configured globally.** `permissionMode` can be `"approve-all"`, `"approve-reads"` (default), or `"deny-all"` (line 18–22, 183). The agent subprocess receives these as command-line flags passed to acpx. Non-interactive fallback policy: `"deny"` (default) or `"fail"`. The agent reports what permission it needs (via ACP `permission` requests); acpx's `nonInteractivePermissions` policy decides how to handle it when no user is present. No backend-signaled approval.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/index.js:18–22`, `614–618`, `1648–1650`

---

### Q7: Runtime code path if an agent had `runtime.type: "acp"`?

**Answer: Would fail validation unless hardcoded into acpx.** The binding registry and agent runner check `agent.runtime?.type === "acp"` (line 109 in `binding-registry-D0ByHSyN.js`) and extract `acp.agent`, `acp.backend`, `acp.mode`, `acp.cwd`. At dispatch time, `isAcpAgentAllowedByPolicy()` (line 21210 in `pi-embedded-BYdcxQ5A.js`) checks if `agentId` is in `cfg.acp.allowedAgents`. If not, it throws `"ACP_AGENT_NOT_ALLOWED"`. If allowed, the runtime calls `acpx <agent> prompt ...` using the builtin command from `ACPX_BUILTIN_AGENT_COMMANDS`, not an arbitrary user-provided binary.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/binding-registry-D0ByHSyN.js:109–115`, `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/pi-embedded-BYdcxQ5A.js:21209–21212`, `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/index.js:917–925`

---

### Q8: Hardcoded process launches?

**Answer: Yes.** Lines 859–874 hardcode the mapping: `claude → "npx -y @zed-industries/claude-agent-acp@0.21.0"`, `codex → "npx -y @zed-industries/codex-acp@0.9.5"`, etc. `resolveAcpxAgentCommand()` returns `ACPX_BUILTIN_AGENT_COMMANDS[normalizedAgent]` unless acpx's own config (not OpenClaw's) overrides it. There is no "custom cc-bridge agent" entry and no way to add one via `openclaw.json`.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/index.js:859–874`, `917–925`

---

### Q9: Protocol spec, README, or type definitions?

**Answer: Minimal.** The bundled `@agentclientprotocol/sdk` (in `node_modules/`) includes a TypeScript SDK README pointing to `https://agentclientprotocol.com` for spec; no local wire format docs. The acpx README (`dist/extensions/acpx/node_modules/acpx/README.md`) documents the CLI and session lifecycle but not the ACP wire format itself—it assumes agents already speak ACP. No JSDoc in the acpx plugin on the `runTurn()` method explains the JSON envelope.

**File:Line:** `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/node_modules/@agentclientprotocol/sdk/README.md:1–45`, `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/extensions/acpx/node_modules/acpx/README.md:1–50`

---

## Recommendation

**Go straight to path (A): HTTP provider.** Register the bridge as `models.providers.cc-bridge` on `http://127.0.0.1:18901/v1`, implement `POST /v1/chat/completions`, and add a binding for the target Telegram peer. Why:

- **ACP is closed to third parties** in this install. The `allowedAgents` list is a hardcoded allowlist in the acpx plugin; you cannot extend it to `["claude", "codex", "gemini", "cc-bridge"]` without patching `/dist/extensions/acpx/index.js` (line 859–874). That violates G's rule: "no patches to `.npm-global`."
- **Documented and proven.** Path (A) is explicitly shown in the config reference as `"baseUrl": "http://localhost:4000/v1"`. DeepSeek and other providers already use it.
- **Fully reversible.** Three config edits, zero dependencies on acpx internals.
- **Persistent CC session is the bridge's problem**, not OpenClaw's. The bridge owns the connection lifecycle; OpenClaw sees only stateless HTTP calls.

The ACP protocol itself is sound (line-delimited JSON, no framing needed, streaming ready), but OpenClaw's implementation is closed to third parties. Revisit only if the HTTP provider path hits an unresolvable blocker.

---

## Open Questions / Unknowns

1. Can acpx's config override extend beyond built-ins? The code path (line 899–915) loads `acpx config show | jq .agents.<name>.command`, but it's unclear if acpx respects a third-party entry in `~/.acpx/config.json` without a pre-existing command template. Likely: **acpx will run any command in its own config, but acpx itself would need to be installed and configured separately—OpenClaw's gateway doesn't control it.**

2. Does the OpenAI-compatible provider path support persistent session state? Path (A) as documented is stateless per OpenClaw call, but the bridge can internally attach session-id-to-Claude-Code-instance mappings. **Not a blocker**—the bridge owns session persistence, not OpenClaw.

3. If the bridge were able to patch acpx at build time (e.g., contributing to the upstream acpx repo), could `cc-bridge` be added to the builtin agents? Yes, but that's out of scope for this task.

