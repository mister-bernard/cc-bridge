// src/session.js
//
// SessionRegistry — maps session-id → ClaudeSupervisor. Lazy spawn, concurrent
// gets for the same id return the same in-flight supervisor promise (no races).

import fs from 'node:fs';
import path from 'node:path';
import { ClaudeSupervisor } from './supervisor.js';
import { SessionStore } from './session-store.js';
import { ConvoLog } from './convo-log.js';

// Read the cross-session shared context file (if present). This file is
// auto-injected into every session's system prompt so decisions made in one
// session (e.g. G approving a subdomain in DM) are visible to others (e.g.
// a group chat session waiting on that approval). Keep it short — this loads
// on every spawn.
function readSharedContext(claudeCwd) {
  if (!claudeCwd) return '';
  const file = path.join(claudeCwd, 'shared-context.md');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return '';
    return `\n\n## Shared cross-session context (decisions, approvals, current state)\n\n${raw}\n\n---\n`;
  } catch {
    return '';
  }
}

export class SessionRegistry {
  constructor({
    claudeBin,
    claudeCwd,
    // cwdBySession: function(sessionId) → string | null.
    // When provided, overrides the working directory for specific sessions.
    // Used to route low-trust sessions (e.g. wire/groups) into a sub-workspace
    // so they load a different CLAUDE.md from the daemon-wide default. Falls
    // back to claudeCwd for any session not matched by the function.
    cwdBySession = null,
    // systemPrompt can be a string (same prompt for every session) OR a
    // function(sessionId) → string (per-session customization). The function
    // shape lets one session use a high-trust prompt while another gets a
    // strict public-facing prompt.
    systemPrompt,
    model,
    extraEnv = {},
    extraArgs = [],
    // extraArgsBySession: function(sessionId) → string[] — per-session
    // claude CLI args. Used for --disallowedTools on public-facing sessions
    // so dangerous tools are blocked at the CC level, not just in the prompt.
    extraArgsBySession = null,
    // statelessFor: function(sessionId) → bool. When true, this session
    // skips ConvoLog injection AND skips appending its turns to ConvoLog.
    // Used for fan-in sessions where many independent users share one
    // cc-bridge session and would otherwise contaminate each other's
    // conversation context (the caller is responsible for sending full
    // per-thread context in each prompt).
    statelessFor = () => false,
    onLog = () => {},
    // Idle timeout in ms. Three shapes accepted:
    //   - 0 (or falsy): never expire (default — preserves v0.1 behavior)
    //   - number > 0: global idle timeout for all sessions
    //   - function(sessionId) → number: per-session lookup; 0 = no timeout
    idleTimeoutMs = 0,
    // How often the sweeper wakes up to check for expirations.
    sweepIntervalMs = 60_000,
    // No-progress watchdog — passed through to every supervisor the
    // registry spawns. See supervisor.js for semantics.
    noProgressTimeoutMs = 30_000,
  }) {
    this.claudeBin = claudeBin;
    this.claudeCwd = claudeCwd;
    this.cwdBySession = typeof cwdBySession === 'function' ? cwdBySession : null;
    this.systemPrompt = systemPrompt;
    // model can be a plain string (same for every session) OR a
    // function(sessionId) → string (per-session override). Per-session
    // overrides let cheap sessions (e.g. a high-volume responder on haiku)
    // run alongside the global default.
    this.model = model;
    this.extraEnv = extraEnv;
    this.extraArgs = extraArgs;
    this.extraArgsBySession = extraArgsBySession;
    this.statelessFor = typeof statelessFor === 'function' ? statelessFor : () => false;
    this.onLog = onLog;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this.noProgressTimeoutMs = noProgressTimeoutMs;
    // session-store kept for future use if CC ever supports --resume in -p mode,
    // but is NOT the primary memory mechanism. ConvoLog is.
    this.store = new SessionStore({
      stateFile: claudeCwd
        ? path.join(claudeCwd, 'session-state.json')
        : undefined,
      onLog,
    });

    // Conversation log — append every turn to JSONL, inject on spawn.
    // This is the reliable memory mechanism: file-based, survives everything.
    this.convoLog = new ConvoLog({
      logsDir: claudeCwd
        ? path.join(claudeCwd, 'conversations')
        : undefined,
      onLog,
    });

    this._pending = new Map(); // id → Promise<ClaudeSupervisor>
    this._ready = new Map(); // id → ClaudeSupervisor (once start() resolves)
    this._sweeper = null;
  }

  _resolveCwd(sessionId) {
    if (this.cwdBySession) {
      const override = this.cwdBySession(sessionId);
      if (override) return override;
    }
    return this.claudeCwd;
  }

  _resolveSystemPrompt(sessionId) {
    if (typeof this.systemPrompt === 'function') {
      return this.systemPrompt(sessionId) || '';
    }
    return this.systemPrompt || '';
  }

  _resolveModel(sessionId) {
    if (typeof this.model === 'function') {
      return this.model(sessionId) || '';
    }
    return this.model || '';
  }

  _resolveExtraArgs(sessionId) {
    const base = Array.isArray(this.extraArgs) ? [...this.extraArgs] : [];
    if (typeof this.extraArgsBySession === 'function') {
      const extra = this.extraArgsBySession(sessionId) || [];
      return base.concat(extra);
    }
    return base;
  }

  _resolveTimeout(sessionId) {
    if (typeof this.idleTimeoutMs === 'function') {
      return this.idleTimeoutMs(sessionId) || 0;
    }
    return Number(this.idleTimeoutMs) || 0;
  }

  startSweeper() {
    if (this._sweeper) return;
    // Only start sweeping if at least one session *could* have a timeout.
    // A function-shaped config is assumed to have per-session overrides.
    if (
      typeof this.idleTimeoutMs !== 'function' &&
      (!this.idleTimeoutMs || this.idleTimeoutMs <= 0)
    ) {
      return;
    }
    this._sweeper = setInterval(() => {
      try {
        this._sweepOnce();
      } catch (err) {
        this.onLog({
          evt: 'registry.sweep.err',
          lvl: 'error',
          err: err.message,
        });
      }
    }, this.sweepIntervalMs);
    // Don't hold the event loop open on the sweeper alone.
    if (this._sweeper.unref) this._sweeper.unref();
  }

  _sweepOnce() {
    const now = Date.now();
    for (const [id, sup] of [...this._ready]) {
      const timeout = this._resolveTimeout(id);
      if (!timeout) continue;
      // Never kill mid-turn.
      if (sup.pendingTurn) continue;
      const lastActivity = sup.lastFrameAt || sup.startedAt || 0;
      if (!lastActivity) continue;
      const idleMs = now - lastActivity;
      if (idleMs < timeout) continue;
      this.onLog({
        evt: 'session.idle_expire',
        session: id,
        idle_ms: idleMs,
        timeout_ms: timeout,
      });
      // Drop the registry entries first so a concurrent get() spawns fresh,
      // then tear down the old child in the background.
      this._ready.delete(id);
      this._pending.delete(id);
      sup.shutdown().catch((err) =>
        this.onLog({
          evt: 'session.idle_shutdown.err',
          lvl: 'error',
          session: id,
          err: err.message,
        }),
      );
    }
  }

  _buildArgs(sessionId) {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',   // -p mode doesn't write ~/.claude/sessions/
      '--permission-mode', 'bypassPermissions',
    ];
    const modelForSession = this._resolveModel(sessionId);
    if (modelForSession) {
      args.push('--model', modelForSession);
    }
    // Build the system prompt: session identity + (optional) shared
    // cross-session context + (optional) conversation history block.
    // For stateless sessions (fan-in responders), skip both shared context
    // and history injection — the caller supplies full per-thread context
    // in each prompt.
    const stateless = this.statelessFor(sessionId);
    const identityPrompt = this._resolveSystemPrompt(sessionId);
    const sharedContext = stateless ? '' : readSharedContext(this._resolveCwd(sessionId));
    const historyBlock = stateless ? '' : this.convoLog.historyBlock(sessionId);
    const fullPrompt = [identityPrompt, sharedContext, historyBlock]
      .filter(Boolean)
      .join('');
    if (fullPrompt) {
      args.push('--append-system-prompt', fullPrompt);
    }
    const msgCount = stateless ? 0 : this.convoLog.count(sessionId);
    this.onLog({
      evt: 'session.spawn',
      session: sessionId,
      history_msgs: msgCount,
      resuming: msgCount > 0,
      stateless,
    });
    return args.concat(this._resolveExtraArgs(sessionId));
  }

  /** True if a supervisor for this session is already running (warm). */
  isWarm(id) {
    return this._ready.has(id) || this._pending.has(id);
  }

  /** Log a turn to the conversation log. Called by the daemon after each exchange. */
  logTurn(sessionId, userText, assistantText) {
    if (this.statelessFor(sessionId)) return;
    this.convoLog.append(sessionId, 'user', userText);
    this.convoLog.append(sessionId, 'assistant', assistantText);
  }

  /** Return conversation log stats for all sessions (for healthz). */
  convoSnapshot() {
    return Object.fromEntries(
      this.convoLog.sessions().map((s) => [s, { msgs: this.convoLog.count(s) }]),
    );
  }

  get(id) {
    const existing = this._pending.get(id);
    if (existing) return existing;

    const promise = (async () => {
      const sup = new ClaudeSupervisor({
        command: this.claudeBin,
        // Pass a factory so each respawn re-evaluates --resume with the
        // latest saved session UUID (set after the first successful turn).
        args: () => this._buildArgs(id),
        cwd: this._resolveCwd(id),
        // Explicitly unset ANTHROPIC_API_KEY so CC uses OAuth from
        // ~/.claude/.credentials.json. An inherited key would silently
        // override OAuth and start billing.
        //
        // SESSION_ID + CC_BRIDGE_PORT are injected so tools running inside
        // the CC turn (notably tg-send-logged.sh) can self-identify as a
        // cc-bridge origin and register with Telegraph for reply routing.
        env: {
          ANTHROPIC_API_KEY: '',
          SESSION_ID: id,
          CC_BRIDGE_PORT: process.env.BRIDGE_PORT || process.env.PORT || '18901',
          ...this.extraEnv,
        },
        noProgressTimeoutMs: this.noProgressTimeoutMs,
        onLog: (evt) => this.onLog({ session: id, ...evt }),
      });
      try {
        await sup.start();
        this._ready.set(id, sup);
        return sup;
      } catch (err) {
        // Allow a retry on next get().
        this._pending.delete(id);
        throw err;
      }
    })();

    this._pending.set(id, promise);
    return promise;
  }

  async shutdown() {
    if (this._sweeper) {
      clearInterval(this._sweeper);
      this._sweeper = null;
    }
    const supervisors = [...this._ready.values()];
    this._ready.clear();
    this._pending.clear();
    await Promise.all(supervisors.map((sup) => sup.shutdown()));
  }

  stats() {
    const out = {};
    for (const [id, sup] of this._ready) {
      out[id] = sup.stats();
    }
    return out;
  }
}
