// src/session.js
//
// SessionRegistry — maps session-id → ClaudeSupervisor. Lazy spawn, concurrent
// gets for the same id return the same in-flight supervisor promise (no races).

import { ClaudeSupervisor } from './supervisor.js';

export class SessionRegistry {
  constructor({
    claudeBin,
    claudeCwd,
    // systemPrompt can be a string (same prompt for every session) OR a
    // function(sessionId) → string (per-session customization). Function
    // shape lets us route session-g through the G-identity prompt while
    // session-groups gets a strict public-facing prompt.
    systemPrompt,
    model,
    extraEnv = {},
    extraArgs = [],
    // extraArgsBySession: function(sessionId) → string[] — per-session
    // claude CLI args. Used for --disallowedTools on session-groups so
    // dangerous tools are blocked at the CC level, not just in the prompt.
    extraArgsBySession = null,
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
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.extraEnv = extraEnv;
    this.extraArgs = extraArgs;
    this.extraArgsBySession = extraArgsBySession;
    this.onLog = onLog;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this.noProgressTimeoutMs = noProgressTimeoutMs;

    this._pending = new Map(); // id → Promise<ClaudeSupervisor>
    this._ready = new Map(); // id → ClaudeSupervisor (once start() resolves)
    this._sweeper = null;
  }

  _resolveSystemPrompt(sessionId) {
    if (typeof this.systemPrompt === 'function') {
      return this.systemPrompt(sessionId) || '';
    }
    return this.systemPrompt || '';
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
      '--permission-mode', 'bypassPermissions',
      // Don't write to ~/.claude/sessions/ — bridge sessions are managed by
      // the registry's own lifecycle, not by CC's session persistence. This
      // prevents bridge sessions from cluttering the session list that CC's
      // --resume and /resume commands show.
      '--no-session-persistence',
    ];
    if (this.model) {
      args.push('--model', this.model);
    }
    const prompt = this._resolveSystemPrompt(sessionId);
    if (prompt) {
      args.push('--append-system-prompt', prompt);
    }
    return args.concat(this._resolveExtraArgs(sessionId));
  }

  get(id) {
    const existing = this._pending.get(id);
    if (existing) return existing;

    const promise = (async () => {
      const sup = new ClaudeSupervisor({
        command: this.claudeBin,
        args: this._buildArgs(id),
        cwd: this.claudeCwd,
        // Explicitly unset ANTHROPIC_API_KEY so CC uses OAuth from
        // ~/.claude/.credentials.json. An inherited key would silently
        // override OAuth and start billing.
        env: { ANTHROPIC_API_KEY: '', ...this.extraEnv },
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
