// src/daemon.js
//
// cc-bridge — persistent Claude Code sessions exposed as an OpenAI-compatible
// /v1/chat/completions endpoint. Production multi-session bridge for gateways,
// chat UIs, Telegram/Signal bots, crons, and anything that speaks OpenAI.
//
// All identity/persona prompts live in prompts/<session-id>.txt files, NOT in
// this source code. The daemon loads them at session spawn time. To customize
// a session's behavior, edit the prompt file and restart the bridge (or let
// the idle timeout expire and the next request lazy-spawns with the new prompt).
//
// Endpoints:
//   GET  /healthz               — no auth; session supervisor stats
//   GET  /v1/models             — bearer required; lists configured sessions
//   POST /v1/chat/completions   — bearer required; dispatches one CC turn
//
// The OpenAI `model` field is parsed as "[<prefix>/]<session-id>". The registry
// lazily spawns one supervisor per session-id on first use.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { SessionRegistry } from './session.js';
import { checkBearer } from './auth.js';

// ---------------------------------------------------------------------------
// Prompt loading — file-based, zero baked-in identity
// ---------------------------------------------------------------------------

const PROMPTS_DIR = process.env.CC_BRIDGE_PROMPTS_DIR ||
  path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..', 'prompts',
  );

function loadPromptFile(name) {
  const filepath = path.join(PROMPTS_DIR, `${name}.txt`);
  try {
    return fs.readFileSync(filepath, 'utf8').trim();
  } catch {
    return null;
  }
}

// Session ids that /v1/models should advertise, comma-separated.
// The registry will lazy-spawn any session id from the model field
// whether or not it's in this list — this is for introspection only.
function listSessionIds() {
  const raw = process.env.CC_BRIDGE_SESSIONS || 'default';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Per-session extra CLI args (JSON map: sessionId → string[]).
function parseSessionExtraArgsMap() {
  const raw = (process.env.CC_BRIDGE_SESSION_EXTRA_ARGS || '').trim();
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object' && !Array.isArray(m)) return m;
  } catch {}
  return null;
}

// Per-session idle timeout (0 = never, number = global, function = per-session).
function parseIdleTimeouts() {
  const raw = (process.env.CC_BRIDGE_SESSION_IDLE_TIMEOUTS_MS || '').trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      return (sessionId) => {
        const v = m[sessionId];
        return typeof v === 'number' ? v : 0;
      };
    }
  } catch {}
  return 0;
}

// ---------------------------------------------------------------------------
// Logging + HTTP helpers
// ---------------------------------------------------------------------------

function formatLogEvent(ev) {
  const level = ev.lvl || 'info';
  const entries = Object.entries(ev).filter(([k]) => k !== 'lvl');
  const pairs = entries
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${s.replace(/\s+/g, ' ')}`;
    })
    .join(' ');
  return `lvl=${level} ${pairs}`;
}

function defaultLog(ev) {
  process.stdout.write(formatLogEvent(ev) + '\n');
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractUserText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer({
  bearer = process.env.CC_BRIDGE_PROVIDER_KEY || '',
  claudeBin = process.env.CLAUDE_BIN || 'claude',
  claudeCwd = process.env.CLAUDE_CWD || process.cwd(),
  model = process.env.CC_BRIDGE_MODEL || 'sonnet',
  // systemPrompt override for tests. In production, prompts are loaded from
  // files in PROMPTS_DIR (prompts/<session-id>.txt → prompts/default.txt).
  systemPrompt: systemPromptOverride,
  sessionExtraArgsMap = parseSessionExtraArgsMap(),
  turnTimeoutMs = parseInt(
    process.env.CC_BRIDGE_TURN_TIMEOUT_MS || '45000',
    10,
  ),
  idleTimeoutMs = parseIdleTimeouts(),
  sweepIntervalMs = parseInt(
    process.env.CC_BRIDGE_SWEEP_INTERVAL_MS || '60000',
    10,
  ),
  noProgressTimeoutMs = parseInt(
    process.env.CC_BRIDGE_NO_PROGRESS_TIMEOUT_MS || '30000',
    10,
  ),
  advertisedSessionIds = listSessionIds(),
  extraEnv = {},
  log = defaultLog,
} = {}) {
  // Resolve the system prompt per session. Priority:
  //   1. explicit `systemPrompt` arg (tests use this — string or function)
  //   2. CC_BRIDGE_SYSTEM_PROMPT env (single prompt for all sessions)
  //   3. File: prompts/<session-id>.txt
  //   4. File: prompts/default.txt
  //   5. Empty string (CC uses its own defaults)
  const resolveSystemPrompt = (sessionId) => {
    if (systemPromptOverride !== undefined) {
      return typeof systemPromptOverride === 'function'
        ? systemPromptOverride(sessionId)
        : systemPromptOverride;
    }
    if (process.env.CC_BRIDGE_SYSTEM_PROMPT) {
      return process.env.CC_BRIDGE_SYSTEM_PROMPT;
    }
    // File-based: try session-specific, then default
    const sessionPrompt = loadPromptFile(sessionId);
    if (sessionPrompt) return sessionPrompt;
    const defaultPrompt = loadPromptFile('default');
    if (defaultPrompt) return defaultPrompt;
    return '';
  };

  // Per-session extra CLI args. Used for tool restrictions on public-facing
  // sessions (e.g., --disallowedTools on session-groups).
  const resolveExtraArgs = (sessionId) => {
    if (sessionExtraArgsMap && Array.isArray(sessionExtraArgsMap[sessionId])) {
      return sessionExtraArgsMap[sessionId];
    }
    // Convention: any session starting with "groups" or "session-groups" gets
    // dangerous tools blocked at the CLI level as defense in depth.
    if (sessionId && (sessionId === 'groups' || sessionId.includes('groups'))) {
      return [
        '--disallowedTools',
        'Bash', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Task',
      ];
    }
    return [];
  };

  const registry = new SessionRegistry({
    claudeBin,
    claudeCwd,
    systemPrompt: resolveSystemPrompt,
    extraArgsBySession: resolveExtraArgs,
    model,
    extraEnv,
    idleTimeoutMs,
    sweepIntervalMs,
    noProgressTimeoutMs,
    onLog: log,
  });
  registry.startSweeper();

  const server = http.createServer(async (req, res) => {
    const reqStart = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, {
        error: { type: 'invalid_request_error', message: 'bad url' },
      });
      return;
    }

    log({
      evt: 'req.in',
      method: req.method,
      path: url.pathname,
      ua: req.headers['user-agent'] || '',
    });
    res.on('finish', () => {
      log({
        evt: 'req.done',
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - reqStart,
      });
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        log({
          evt: 'req.abort',
          lvl: 'warn',
          path: url.pathname,
          ms: Date.now() - reqStart,
        });
      }
    });

    try {
      // --- /healthz (no auth) -------------------------------------------
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          service: 'cc-bridge',
          version: '0.2.0',
          prompts_dir: PROMPTS_DIR,
          sessions: registry.stats(),
        });
        return;
      }

      // --- /v1/models (bearer) ------------------------------------------
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        if (!checkBearer(req, bearer)) {
          sendJson(res, 401, {
            error: {
              type: 'authentication_error',
              message: 'missing or invalid bearer',
            },
          });
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        sendJson(res, 200, {
          object: 'list',
          data: advertisedSessionIds.map((id) => ({
            id,
            object: 'model',
            created: now,
            owned_by: 'cc-bridge',
          })),
        });
        return;
      }

      // --- /v1/chat/completions (bearer) --------------------------------
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        if (!checkBearer(req, bearer)) {
          sendJson(res, 401, {
            error: {
              type: 'authentication_error',
              message: 'missing or invalid bearer',
            },
          });
          return;
        }

        let raw;
        try {
          raw = await readBody(req);
        } catch (err) {
          sendJson(res, 413, {
            error: { type: 'invalid_request_error', message: err.message },
          });
          return;
        }

        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, {
            error: { type: 'invalid_request_error', message: 'invalid JSON' },
          });
          return;
        }

        // Strip any "<provider>/" prefix from the model string.
        const modelId = (body.model || '').replace(/^.*\//, '');
        if (!modelId) {
          sendJson(res, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'missing model field',
            },
          });
          return;
        }

        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          sendJson(res, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'messages must be a non-empty array',
            },
          });
          return;
        }

        const lastUser = [...body.messages]
          .reverse()
          .find((m) => m && m.role === 'user');
        if (!lastUser) {
          sendJson(res, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'no user message in messages',
            },
          });
          return;
        }

        const userText = extractUserText(lastUser);
        if (!userText.trim()) {
          sendJson(res, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'empty user message content',
            },
          });
          return;
        }

        // Forward the OpenAI `user` field (typically "<channel>:<verified-id>")
        // as a prompt-visible tag so the system prompt can self-gate by identity.
        const peerTag = typeof body.user === 'string' ? body.user : '';
        const promptText = peerTag
          ? `[peer=${peerTag}]\n${userText}`
          : userText;

        let sup;
        try {
          sup = await registry.get(modelId);
        } catch (err) {
          log({
            evt: 'session.spawn.fail',
            lvl: 'error',
            model: modelId,
            err: err.message,
          });
          sendJson(res, 503, {
            error: {
              type: 'upstream_error',
              message: 'cc session failed to start',
            },
          });
          return;
        }

        let result;
        try {
          result = await sup.sendPrompt(promptText, {
            timeoutMs: turnTimeoutMs,
          });
        } catch (err) {
          log({
            evt: 'turn.fail',
            lvl: 'error',
            model: modelId,
            err: err.message,
          });
          const status = /timeout/i.test(err.message) ? 504 : 503;
          sendJson(res, status, {
            error: { type: 'upstream_error', message: err.message },
          });
          return;
        }

        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        if (body.stream === true) {
          // SSE — the path most OpenAI-speaking gateways take (they set
          // stream:true regardless of the caller). Emit role → content →
          // finish → [DONE]. Claude returns the whole turn at once so
          // there's nothing to stream progressively.
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
          });
          const emit = (chunk) =>
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          emit({
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [
              { index: 0, delta: { role: 'assistant' }, finish_reason: null },
            ],
          });
          emit({
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { content: result.text },
                finish_reason: null,
              },
            ],
          });
          emit({
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: result.text,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        });
        return;
      }

      sendJson(res, 404, {
        error: { type: 'not_found_error', message: 'unknown route' },
      });
    } catch (err) {
      log({ evt: 'req.err', lvl: 'error', err: err.message });
      try {
        sendJson(res, 500, {
          error: { type: 'server_error', message: 'internal error' },
        });
      } catch {
        // response already started
      }
    }
  });

  server.registry = registry;
  server.shutdown = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await registry.shutdown();
  };

  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = parseInt(process.env.BRIDGE_PORT || '18901', 10);
  const bind = process.env.BRIDGE_BIND || '127.0.0.1';

  if (!process.env.CC_BRIDGE_PROVIDER_KEY) {
    defaultLog({
      evt: 'daemon.start',
      lvl: 'warn',
      msg: 'CC_BRIDGE_PROVIDER_KEY is empty — auth disabled (loopback only)',
    });
  }

  defaultLog({
    evt: 'daemon.start',
    prompts_dir: PROMPTS_DIR,
    prompts: fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.txt')).join(','),
  });

  const server = createServer();
  server.listen(port, bind, () => {
    defaultLog({ evt: 'daemon.listen', bind, port });
  });

  const shutdown = async (reason) => {
    defaultLog({ evt: 'daemon.shutdown', reason });
    try {
      await server.shutdown();
    } catch (err) {
      defaultLog({
        evt: 'daemon.shutdown.err',
        lvl: 'error',
        err: err.message,
      });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
