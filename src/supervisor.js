// src/supervisor.js
//
// ClaudeSupervisor — holds a persistent `claude` child with stream-json IO,
// one turn in flight at a time per supervisor, auto-respawn on unexpected exit.
//
// Contract:
//   const sup = new ClaudeSupervisor({ command, args, env, cwd, onLog });
//   await sup.start();                             // resolves when init frame seen
//   const { text, session_id } = await sup.sendPrompt("hi", { timeoutMs });
//   await sup.shutdown();                          // terminates child, no more respawns
//
// Internal invariants:
//   - Turns are serialized via a promise chain (`this.chain`). Only one
//     `pendingTurn` is ever set; concurrent callers are enqueued.
//   - `_handleExit` rejects any in-flight turn and schedules a respawn unless
//     `shutdownRequested` is set.
//   - All emitted log events go through `onLog(event)`; the caller decides
//     whether to print them.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const RESPAWN_BACKOFF_MS = 500;

export class ClaudeSupervisor {
  constructor({
    command,
    args = [],
    env = {},
    cwd,
    onLog = () => {},
    // No-progress watchdog: if the claude child is in a turn but hasn't
    // emitted any stream-json frame for this many ms, assume it's stuck
    // (alive but silent) and force-kill it so the pending turn fails fast.
    // This is distinct from the per-turn timeout passed to sendPrompt,
    // which is an absolute duration cap. The watchdog catches the "child
    // alive but producing nothing" case that otherwise eats the full turn
    // timeout before surfacing as an error. 0 disables.
    noProgressTimeoutMs = 30000,
  }) {
    this.command = command;
    // args can be a plain array (fixed) or a function() → string[] (evaluated
    // on every spawn so --resume can be injected after the first session ID
    // is saved without recreating the supervisor).
    this._argsFactory = typeof args === 'function' ? args : () => args;
    this.env = { ...process.env, ...env };
    this.cwd = cwd;
    this.onLog = onLog;
    this.noProgressTimeoutMs = noProgressTimeoutMs;

    this.child = null;
    this.rl = null;

    this.pendingTurn = null;
    this.chain = Promise.resolve();

    this.shutdownRequested = false;
    this.lastFrameAt = 0;
    this.spawnCount = 0;
    this.startedAt = 0;
    this.sessionId = null;
  }

  _clearTurnTimers(pt) {
    if (!pt) return;
    if (pt.timer) { clearTimeout(pt.timer); pt.timer = null; }
    if (pt.noProgressInterval) { clearInterval(pt.noProgressInterval); pt.noProgressInterval = null; }
  }

  _armNoProgressWatchdog(pt) {
    if (!this.noProgressTimeoutMs || this.noProgressTimeoutMs <= 0) return;
    // Check every ~5s (or 1/6th of the threshold, whichever is smaller,
    // with a 200ms floor so tests with tiny thresholds are responsive).
    const step = Math.max(200, Math.min(5000, Math.floor(this.noProgressTimeoutMs / 6)));
    pt.progressStartedAt = Date.now();
    pt.noProgressInterval = setInterval(() => {
      if (this.pendingTurn !== pt) {
        clearInterval(pt.noProgressInterval);
        return;
      }
      // Reference point: the later of last-frame-time and turn-start-time.
      // Before the first frame, we haven't heard from the child yet — still
      // measure silence from the turn start.
      const lastProgress = Math.max(this.lastFrameAt, pt.progressStartedAt);
      const elapsed = Date.now() - lastProgress;
      if (elapsed >= this.noProgressTimeoutMs) {
        const stuck = pt;
        this.pendingTurn = null;
        this._clearTurnTimers(stuck);
        this.onLog({
          evt: 'claude.no_progress_timeout',
          elapsed_ms: elapsed,
          threshold_ms: this.noProgressTimeoutMs,
        });
        try { this.child && this.child.kill('SIGKILL'); } catch {}
        stuck.reject(new Error(`claude stuck: no stdout frame in ${elapsed}ms (threshold ${this.noProgressTimeoutMs}ms)`));
      }
    }, step);
  }

  start() {
    this.shutdownRequested = false;
    return this._spawn();
  }

  _spawn() {
    this.spawnCount += 1;
    this.startedAt = Date.now();
    this.onLog({ evt: 'claude.spawn', cmd: this.command, attempt: this.spawnCount });

    // `claude -p --input-format stream-json` does NOT emit an init frame at
    // startup — init arrives only after the first user frame is written to
    // stdin. So start() completes as soon as the child process has been
    // spawned; the first `sendPrompt` is what actually wakes claude up.
    const currentArgs = this._argsFactory();
    this.onLog({ evt: 'claude.args', args: currentArgs.join(' ') });
    try {
      this.child = spawn(this.command, currentArgs, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.onLog({ evt: 'claude.spawn.err', err: err.message });
      this.child = null;
      return Promise.reject(err);
    }

    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this._handleLine(line));
    this.child.stderr.on('data', (d) =>
      this.onLog({ evt: 'claude.stderr', text: d.toString().trim() }),
    );
    this.child.on('error', (err) =>
      this.onLog({ evt: 'claude.error', err: err.message }),
    );
    this.child.on('exit', (code, signal) => this._handleExit(code, signal));

    return Promise.resolve();
  }

  _handleExit(code, signal) {
    const uptime = this.startedAt
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;
    this.onLog({ evt: 'claude.exit', code, signal, uptime_sec: uptime });

    this.child = null;

    // Reject any in-flight turn.
    if (this.pendingTurn) {
      const pt = this.pendingTurn;
      this.pendingTurn = null;
      this._clearTurnTimers(pt);
      pt.reject(new Error(`claude exited mid-turn (code=${code}, signal=${signal})`));
    }

    // Respawn unless shutting down.
    if (!this.shutdownRequested) {
      setTimeout(() => {
        if (!this.shutdownRequested) {
          this._spawn().catch((err) =>
            this.onLog({ evt: 'claude.respawn.err', err: err.message }),
          );
        }
      }, RESPAWN_BACKOFF_MS);
    }
  }

  _handleLine(line) {
    if (!line.trim()) return;
    this.lastFrameAt = Date.now();

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onLog({ evt: 'claude.bad_line', line: line.slice(0, 200) });
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      this.sessionId = msg.session_id || null;
      this.onLog({ evt: 'claude.ready', session_id: this.sessionId });
      return;
    }

    const pt = this.pendingTurn;
    if (!pt) {
      // Event outside a turn — usually a late tool event after result.
      this.onLog({ evt: 'claude.stray', type: msg.type });
      return;
    }

    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (typeof content === 'string') {
        pt.buffer.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            pt.buffer.push(block.text);
          }
        }
      }
      return;
    }

    if (msg.type === 'result') {
      this._clearTurnTimers(pt);
      this.pendingTurn = null;
      // Upstream errors (e.g. "model not found") come back as result frames
      // with `is_error: true`. Reject so OpenClaw's model.fallbacks kick in.
      if (msg.is_error === true) {
        const msgText =
          typeof msg.result === 'string' ? msg.result : 'claude upstream error';
        pt.reject(new Error(msgText));
        return;
      }
      const finalText =
        typeof msg.result === 'string' && msg.result.length > 0
          ? msg.result
          : pt.buffer.join('');
      pt.resolve({ text: finalText, session_id: msg.session_id || this.sessionId });
    }

    // Other frame types (thinking, tool_use, tool_result) — ignored for v1.
  }

  sendPrompt(text, { timeoutMs = 120000 } = {}) {
    const run = () =>
      new Promise((resolve, reject) => {
        (async () => {
          try {
            if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
              reject(new Error('claude not writable'));
              return;
            }
            if (this.pendingTurn) {
              // Should never happen given the chain serialization, but defend.
              reject(new Error('turn already in flight'));
              return;
            }

            const timer = setTimeout(() => {
              if (this.pendingTurn) {
                const pt = this.pendingTurn;
                this.pendingTurn = null;
                this._clearTurnTimers(pt);
                const partial = pt.buffer.join('');
                this.onLog({
                  evt: 'claude.turn_timeout',
                  timeout_ms: timeoutMs,
                  partial_bytes: partial.length,
                });
                if (partial.length > 0) {
                  // Preserve in-flight assistant output rather than dropping
                  // it as a 504. The child is still killed so the next turn
                  // gets a fresh process; the caller gets what was produced
                  // plus a truncation marker so it's clear the answer was
                  // cut off mid-stream.
                  const truncSec = Math.floor(timeoutMs / 1000);
                  pt.resolve({
                    text: `${partial}\n\n[turn truncated after ${truncSec}s — output cut off mid-stream]`,
                    session_id: this.sessionId,
                  });
                } else {
                  pt.reject(new Error('turn timeout'));
                }
                try {
                  this.child && this.child.kill('SIGTERM');
                } catch {}
              }
            }, timeoutMs);

            const pt = { resolve, reject, buffer: [], timer, noProgressInterval: null };
            this.pendingTurn = pt;
            this._armNoProgressWatchdog(pt);

            const frame =
              JSON.stringify({
                type: 'user',
                message: { role: 'user', content: text },
              }) + '\n';

            this.child.stdin.write(frame, (err) => {
              if (err && this.pendingTurn) {
                this._clearTurnTimers(this.pendingTurn);
                this.pendingTurn = null;
                reject(err);
              }
            });
          } catch (err) {
            reject(err);
          }
        })();
      });

    // Strict FIFO serialization; rejections don't break the chain.
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  async shutdown() {
    this.shutdownRequested = true;
    if (!this.child) return;
    try {
      this.child.kill('SIGTERM');
    } catch {}
    const start = Date.now();
    while (this.child && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {}
    }
  }

  stats() {
    return {
      pid: this.child?.pid ?? null,
      session_id: this.sessionId,
      uptime_sec: this.startedAt
        ? Math.floor((Date.now() - this.startedAt) / 1000)
        : 0,
      last_frame_age_sec: this.lastFrameAt
        ? Math.floor((Date.now() - this.lastFrameAt) / 1000)
        : null,
      spawn_count: this.spawnCount,
      busy: !!this.pendingTurn,
    };
  }
}
