// src/boot-notifier.js
//
// Sends a "spinning up" Telegram message when a session cold-starts, so users
// aren't left staring at silence for 15-30s wondering if the agent is dead.
//
// On first successful turn, the boot message is deleted and replaced by the
// real response — clean UX: user sees one message, not two.
//
// Config (env):
//   CC_BRIDGE_TG_BOT_TOKEN      — Telegram bot token
//   CC_BRIDGE_SESSION_TG_GROUPS — JSON map: sessionId → array of chat IDs
//     e.g. {"session-tom": ["-5271053898", "-5281764808"], "session-elina": ["-5190022092"]}

import https from 'node:https';

const DEFAULT_BOOT_TEXTS = [
  '⚡ spinning up...',
];

function parseTgGroups() {
  const raw = (process.env.CC_BRIDGE_SESSION_TG_GROUPS || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // Normalise: values can be a string (single chat) or array
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = Array.isArray(v) ? v.map(String) : [String(v)];
    }
    return out;
  } catch {
    return {};
  }
}

function tgPost(botToken, method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('tg timeout')); });
    req.write(payload);
    req.end();
  });
}

export class BootNotifier {
  constructor({ botToken, sessionTgGroups, onLog = () => {} } = {}) {
    this.botToken = botToken || process.env.CC_BRIDGE_TG_BOT_TOKEN
                             || process.env.TELEGRAM_BOT_TOKEN || '';
    this.groups = sessionTgGroups || parseTgGroups();
    this.onLog = onLog;
    // Track pending boot message_ids so we can delete them after first response
    // Map: `${sessionId}:${chatId}` → message_id
    this._pending = new Map();
  }

  /** Return the list of Telegram chat IDs mapped to this session, or []. */
  chatsFor(sessionId) {
    return this.groups[sessionId] || [];
  }

  /**
   * Send "spinning up" messages to all chats mapped to this session.
   * Returns immediately; messages are sent fire-and-forget.
   */
  notifyBoot(sessionId) {
    if (!this.botToken) return;
    const chats = this.chatsFor(sessionId);
    if (!chats.length) return;

    for (const chatId of chats) {
      const text = DEFAULT_BOOT_TEXTS[0];
      tgPost(this.botToken, 'sendMessage', {
        chat_id: chatId,
        text,
        disable_notification: true,  // silent — no buzz on the phone
      })
        .then((res) => {
          if (res.ok && res.result?.message_id) {
            const key = `${sessionId}:${chatId}`;
            this._pending.set(key, res.result.message_id);
            this.onLog({
              evt: 'boot.notified',
              session: sessionId,
              chat_id: chatId,
              msg_id: res.result.message_id,
            });
          }
        })
        .catch((err) => {
          this.onLog({
            evt: 'boot.notify.err',
            lvl: 'warn',
            session: sessionId,
            chat_id: chatId,
            err: err.message,
          });
        });
    }
  }

  /**
   * Delete the boot messages for this session (called after first response).
   * No-ops if no boot messages were sent or already cleaned up.
   */
  clearBoot(sessionId) {
    if (!this.botToken) return;
    const chats = this.chatsFor(sessionId);
    for (const chatId of chats) {
      const key = `${sessionId}:${chatId}`;
      const msgId = this._pending.get(key);
      if (!msgId) continue;
      this._pending.delete(key);
      tgPost(this.botToken, 'deleteMessage', {
        chat_id: chatId,
        message_id: msgId,
      }).catch(() => {}); // best-effort
    }
  }

  /** True if this session has an outstanding boot message. */
  hasPending(sessionId) {
    const chats = this.chatsFor(sessionId);
    return chats.some((c) => this._pending.has(`${sessionId}:${c}`));
  }
}
