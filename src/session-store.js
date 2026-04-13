// src/session-store.js
//
// Lightweight file-backed store mapping bridge session names to their
// Claude session UUIDs. Lets us --resume the right session on respawn
// so conversation context survives process restarts, idle timeouts, and
// no-progress kills.
//
// Format of the JSON file:
//   {
//     "session-tom":   { "claudeSessionId": "abc-...", "savedAt": 1713... },
//     "session-elina": { "claudeSessionId": "def-...", "savedAt": 1713... }
//   }

import fs from 'node:fs';
import path from 'node:path';

export class SessionStore {
  constructor({ stateFile, claudeSessionsDir, onLog = () => {} } = {}) {
    // Where we write our own index: <claudeCwd>/session-state.json
    this.stateFile = stateFile || path.join(process.cwd(), 'session-state.json');
    // Where Claude writes session persistence files (default: ~/.claude/sessions/)
    this.claudeSessionsDir =
      claudeSessionsDir ||
      path.join(process.env.HOME || '/root', '.claude', 'sessions');
    this.onLog = onLog;
    this._data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  _persist() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this._data, null, 2));
    } catch (err) {
      this.onLog({ evt: 'session-store.write.err', lvl: 'warn', err: err.message });
    }
  }

  /**
   * Return the Claude session UUID for a bridge session, or null if unknown
   * or if the corresponding session file no longer exists on disk.
   */
  get(bridgeSessionId) {
    const entry = this._data[bridgeSessionId];
    if (!entry?.claudeSessionId) return null;

    // Verify the CC session file still exists (CC may have pruned old sessions).
    // CC stores sessions as <pid>.json, each containing a sessionId UUID.
    // Scan for a file that claims our UUID.
    const id = entry.claudeSessionId;
    try {
      const files = fs.readdirSync(this.claudeSessionsDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = fs.readFileSync(
            path.join(this.claudeSessionsDir, f),
            'utf8',
          );
          const obj = JSON.parse(raw);
          if (obj.sessionId === id) return id; // found
        } catch {
          // ignore malformed files
        }
      }
    } catch {
      // sessions dir doesn't exist yet — session can't be found
    }
    // Session UUID no longer on disk — clear our record
    this.onLog({
      evt: 'session-store.stale',
      bridge: bridgeSessionId,
      claude_id: id,
    });
    delete this._data[bridgeSessionId];
    this._persist();
    return null;
  }

  /** Record the Claude session UUID for a bridge session. */
  set(bridgeSessionId, claudeSessionId) {
    if (!claudeSessionId) return;
    const prev = this._data[bridgeSessionId]?.claudeSessionId;
    if (prev === claudeSessionId) return; // no change
    this._data[bridgeSessionId] = {
      claudeSessionId,
      savedAt: Date.now(),
    };
    this._persist();
    this.onLog({
      evt: 'session-store.saved',
      bridge: bridgeSessionId,
      claude_id: claudeSessionId,
    });
  }

  /** Remove session mapping (e.g., when starting fresh intentionally). */
  clear(bridgeSessionId) {
    if (this._data[bridgeSessionId]) {
      delete this._data[bridgeSessionId];
      this._persist();
    }
  }

  snapshot() {
    return Object.fromEntries(
      Object.entries(this._data).map(([k, v]) => [
        k,
        { claude_id: v.claudeSessionId, saved_at: v.savedAt },
      ]),
    );
  }
}
