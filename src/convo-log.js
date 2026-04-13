// src/convo-log.js
//
// Append-only JSONL conversation log per session. Every user message and
// assistant response is written to disk immediately. On each process spawn
// the last N exchanges are read back and injected into the system prompt,
// giving the session real conversational memory that survives:
//   - idle timeouts
//   - no-progress SIGKILL
//   - cc-bridge restarts
//   - server reboots
//
// Files live at: <logsDir>/<sessionId>.jsonl
// Each line: {"role":"user"|"assistant","content":"...","ts":1234567890}
//
// Why JSONL over SQLite/JSON: append is atomic at the OS level for small
// writes, no parse overhead, easy to tail/grep, zero dependencies.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_INJECT_TURNS = 30; // last N user+assistant pairs to inject

export class ConvoLog {
  constructor({ logsDir, injectTurns = DEFAULT_INJECT_TURNS, onLog = () => {} } = {}) {
    this.logsDir = logsDir || path.join(process.cwd(), 'conversations');
    this.injectTurns = injectTurns;
    this.onLog = onLog;
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
    } catch {}
  }

  _filePath(sessionId) {
    return path.join(this.logsDir, `${sessionId}.jsonl`);
  }

  /** Append a message to the log. Fire-and-forget. */
  append(sessionId, role, content) {
    const entry = JSON.stringify({ role, content: content.slice(0, 8000), ts: Date.now() });
    try {
      fs.appendFileSync(this._filePath(sessionId), entry + '\n');
    } catch (err) {
      this.onLog({ evt: 'convo-log.write.err', lvl: 'warn', session: sessionId, err: err.message });
    }
  }

  /**
   * Read the last `injectTurns` exchanges (each exchange = 1 user + 1 assistant message)
   * and return them as a formatted string to embed in the system prompt.
   * Returns empty string if no history exists.
   */
  historyBlock(sessionId) {
    const file = this._filePath(sessionId);
    let lines;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      lines = raw.trim().split('\n').filter(Boolean);
    } catch {
      return ''; // no history yet
    }
    if (!lines.length) return '';

    // Take last injectTurns * 2 lines (each turn = user + assistant)
    const tail = lines.slice(-(this.injectTurns * 2));
    const messages = tail.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    if (!messages.length) return '';

    const formatted = messages.map((m) => {
      const label = m.role === 'user' ? 'User' : 'Mr. Bernard';
      const time = new Date(m.ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      return `[${time}] ${label}: ${m.content}`;
    }).join('\n\n');

    return `\n\n## Conversation history (last ${messages.length} messages — use for context)\n\n${formatted}\n\n---\n`;
  }

  /** Return total message count for a session (for healthz/debug). */
  count(sessionId) {
    try {
      const raw = fs.readFileSync(this._filePath(sessionId), 'utf8');
      return raw.trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  /** List all sessions that have logs. */
  sessions() {
    try {
      return fs.readdirSync(this.logsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace('.jsonl', ''));
    } catch {
      return [];
    }
  }
}
