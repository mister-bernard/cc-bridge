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

// Linux MAX_ARG_STRLEN is PAGE_SIZE * 32 = 128KB per single argv string. The
// historyBlock is passed as one `--append-system-prompt <string>` argument, so
// it must stay well under that ceiling. Default 80KB leaves headroom for the
// identity prompt + shared-context block sharing the same arg. Override with
// CC_BRIDGE_HISTORY_MAX_BYTES if a higher-trust session needs deeper history
// and you're confident the combined arg stays under MAX_ARG_STRLEN.
const DEFAULT_HISTORY_MAX_BYTES =
  parseInt(process.env.CC_BRIDGE_HISTORY_MAX_BYTES || '80000', 10);

// Label used to tag the assistant's turns in the injected history block.
// Override with CC_BRIDGE_ASSISTANT_LABEL or via the constructor option.
const DEFAULT_ASSISTANT_LABEL = process.env.CC_BRIDGE_ASSISTANT_LABEL || 'Assistant';

export class ConvoLog {
  constructor({
    logsDir,
    injectTurns = DEFAULT_INJECT_TURNS,
    historyMaxBytes = DEFAULT_HISTORY_MAX_BYTES,
    assistantLabel = DEFAULT_ASSISTANT_LABEL,
    onLog = () => {},
  } = {}) {
    this.logsDir = logsDir || path.join(process.cwd(), 'conversations');
    this.injectTurns = injectTurns;
    this.historyMaxBytes = historyMaxBytes;
    this.assistantLabel = assistantLabel;
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
    let messages = tail.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    if (!messages.length) return '';

    const fmt = (m) => {
      const label = m.role === 'user' ? 'User' : this.assistantLabel;
      const time = new Date(m.ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      return `[${time}] ${label}: ${m.content}`;
    };
    const SEP = '\n\n';
    const wrap = (body, n) =>
      `\n\n## Conversation history (last ${n} messages — use for context)\n\n${body}\n\n---\n`;

    // Drop oldest messages until the rendered block fits under historyMaxBytes.
    // Without this, a long-running session whose per-message content is near the
    // 8000-char cap can produce a single argv string that exceeds Linux's
    // 128KB MAX_ARG_STRLEN, causing claude spawns to fail with E2BIG.
    let formatted = messages.map(fmt).join(SEP);
    let block = wrap(formatted, messages.length);
    const initialCount = messages.length;
    while (Buffer.byteLength(block, 'utf8') > this.historyMaxBytes && messages.length > 2) {
      messages = messages.slice(1);
      formatted = messages.map(fmt).join(SEP);
      block = wrap(formatted, messages.length);
    }
    if (messages.length < initialCount) {
      this.onLog({
        evt: 'convo-log.history.trimmed',
        kept: messages.length,
        dropped: initialCount - messages.length,
        max_bytes: this.historyMaxBytes,
        final_bytes: Buffer.byteLength(block, 'utf8'),
      });
    }
    return block;
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
