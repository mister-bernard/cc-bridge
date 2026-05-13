// tests/unit/daemon.test.js
//
// Layer A — daemon + supervisor in isolation, with the fake-claude stubs.
// No network, no real claude spawn, no API credits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/daemon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_OK = path.resolve(__dirname, '../fake-claude');
const STUB_HANG = path.resolve(__dirname, '../fake-claude-hang');
const STUB_PARTIAL_HANG = path.resolve(__dirname, '../fake-claude-partial-hang');
const STUB_CRASH = path.resolve(__dirname, '../fake-claude-crash');

const BEARER = 'test-bearer-unit';

function silentLog() {}

function startServer(opts = {}) {
  const server = createServer({
    bearer: BEARER,
    claudeBin: STUB_OK,
    claudeCwd: process.cwd(),
    model: '', // skip --model flag for stubs
    systemPrompt: '', // skip --append-system-prompt for stubs
    turnTimeoutMs: 5000,
    batchDebounceMs: 0, // disable batching for existing tests
    advertisedSessionIds: ["session-default", "session-secondary"],
    log: silentLog,
    ...opts,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'GET', path: reqPath, headers = {} }, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, body: json, raw });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

const authed = { authorization: `Bearer ${BEARER}` };

test('A1 POST /v1/chat/completions with valid body → 200 + assistant content', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'cc-bridge/session-default',
        messages: [{ role: 'user', content: 'hello' }],
      },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.object, 'chat.completion');
    assert.equal(r.body.choices[0].message.role, 'assistant');
    assert.equal(typeof r.body.choices[0].message.content, 'string');
    assert.ok(r.body.choices[0].message.content.length > 0);
    assert.equal(r.body.choices[0].finish_reason, 'stop');
    assert.equal(r.body.model, 'session-default'); // prefix stripped
  } finally {
    await server.shutdown();
  }
});

test('A1b model without cc-bridge/ prefix also works', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-default', messages: [{ role: 'user', content: 'hi' }] },
    );
    assert.equal(r.status, 200);
  } finally {
    await server.shutdown();
  }
});

test('A1c content-array form (OpenAI multimodal shape) is handled', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'session-default',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'array form' }],
          },
        ],
      },
    );
    assert.equal(r.status, 200);
    assert.ok(r.body.choices[0].message.content.length > 0);
  } finally {
    await server.shutdown();
  }
});

test('A1d prior assistant turns in history are ignored; last user wins', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'session-default',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'earlier reply' },
          { role: 'user', content: 'latest' },
        ],
      },
    );
    assert.equal(r.status, 200);
  } finally {
    await server.shutdown();
  }
});

test('A2 missing messages field → 400', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-default' },
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.error.type, 'invalid_request_error');
  } finally {
    await server.shutdown();
  }
});

test('A2b empty user content → 400', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'session-default',
        messages: [{ role: 'user', content: '   ' }],
      },
    );
    assert.equal(r.status, 400);
  } finally {
    await server.shutdown();
  }
});

test('A2c missing model → 400', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { messages: [{ role: 'user', content: 'hi' }] },
    );
    assert.equal(r.status, 400);
  } finally {
    await server.shutdown();
  }
});

test('A2d invalid JSON body → 400', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      'not json at all',
    );
    assert.equal(r.status, 400);
  } finally {
    await server.shutdown();
  }
});

test('A3 three concurrent POSTs on same session serialize and all succeed', async () => {
  // Use a slight stub delay so the requests overlap in the chain.
  const server = await startServer({
    extraEnv: { FAKE_CLAUDE_TURN_DELAY: '0.1' },
  });
  try {
    const send = (n) =>
      request(
        server,
        { method: 'POST', path: '/v1/chat/completions', headers: authed },
        {
          model: 'session-default',
          messages: [{ role: 'user', content: `q${n}` }],
        },
      );
    const results = await Promise.all([send(1), send(2), send(3)]);
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.ok(r.body.choices[0].message.content.length > 0);
    }
  } finally {
    await server.shutdown();
  }
});

test('A4 hanging stub + 1s timeout → 504', async () => {
  const server = await startServer({
    claudeBin: STUB_HANG,
    turnTimeoutMs: 1000,
    noProgressTimeoutMs: 0, // disable the watchdog so this test exercises the absolute turn timeout
  });
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'session-default',
        messages: [{ role: 'user', content: 'never replies' }],
      },
    );
    assert.equal(r.status, 504);
    assert.equal(r.body.error.type, 'upstream_error');
  } finally {
    await server.shutdown();
  }
});

test('A4c partial-hang stub + 1s turn timeout → 200 with buffered text + truncation marker', async () => {
  const server = await startServer({
    claudeBin: STUB_PARTIAL_HANG,
    turnTimeoutMs: 1000,
    noProgressTimeoutMs: 0, // disable so absolute turn timeout fires
    extraEnv: { FAKE_CLAUDE_PARTIAL: 'half-baked answer so far' },
  });
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'session-default',
        messages: [{ role: 'user', content: 'long task' }],
      },
    );
    assert.equal(r.status, 200, 'partial buffer should be returned, not 504');
    const content = r.body.choices[0].message.content;
    assert.match(content, /half-baked answer so far/);
    assert.match(content, /turn truncated/i, 'truncation marker present');
  } finally {
    await server.shutdown();
  }
});

test('A4b hanging stub + no-progress watchdog (500ms) fires faster than absolute turn timeout (60s)', async () => {
  const started = Date.now();
  const server = await startServer({
    claudeBin: STUB_HANG,
    turnTimeoutMs: 60000, // long absolute budget
    noProgressTimeoutMs: 500, // but if no frame in 500ms, give up
  });
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'session-default',
        messages: [{ role: 'user', content: 'never replies' }],
      },
    );
    const elapsed = Date.now() - started;
    assert.equal(r.status, 503, 'no-progress fires as upstream_error/503');
    assert.equal(r.body.error.type, 'upstream_error');
    assert.match(r.body.error.message, /stuck/, 'error mentions stuck');
    assert.ok(
      elapsed < 5000,
      `should fire in <5s (watchdog=500ms), took ${elapsed}ms`,
    );
  } finally {
    await server.shutdown();
  }
});

test('A5 crashing stub → 503 and daemon stays up', async () => {
  const server = await startServer({
    claudeBin: STUB_CRASH,
    turnTimeoutMs: 2000,
  });
  try {
    const r1 = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-default', messages: [{ role: 'user', content: 'boom' }] },
    );
    assert.equal(r1.status, 503);
    // Daemon must still be alive and serving /healthz.
    const r2 = await request(server, { method: 'GET', path: '/healthz' });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.ok, true);
  } finally {
    await server.shutdown();
  }
});

test('GET /healthz → 200 with sessions map', async () => {
  const server = await startServer();
  try {
    const r = await request(server, { method: 'GET', path: '/healthz' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.service, 'cc-bridge');
    assert.ok(typeof r.body.version === 'string' && r.body.version.length > 0);
    assert.equal(typeof r.body.sessions, 'object');
  } finally {
    await server.shutdown();
  }
});

test('GET /v1/models with bearer → list shape', async () => {
  const server = await startServer();
  try {
    const r = await request(server, {
      method: 'GET',
      path: '/v1/models',
      headers: authed,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.object, 'list');
    assert.ok(Array.isArray(r.body.data));
    assert.ok(r.body.data.find((m) => m.id === 'session-default'));
  } finally {
    await server.shutdown();
  }
});

test('WIRE1 createServer wires sessionModelMap + sessionStatelessSet through to the registry', async () => {
  const server = await startServer({
    sessionModelMap: { 'session-stateless': 'haiku' },
    sessionStatelessSet: new Set(['session-stateless']),
  });
  try {
    const reg = server.registry;
    // After a turn, stateless session must NOT have written to convo log,
    // and a stateful session must have.
    await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-stateless', messages: [{ role: 'user', content: 'hi y' }] },
    );
    await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-default', messages: [{ role: 'user', content: 'hi g' }] },
    );
    assert.equal(reg.convoLog.count('session-stateless'), 0,
      'stateless session must not append to convo log');
    assert.ok(reg.convoLog.count('session-default') >= 2,
      'stateful session must record turns');
    // Direct buildArgs check confirms model wiring.
    const argsY = reg._buildArgs('session-stateless');
    const idx = argsY.indexOf('--model');
    assert.equal(argsY[idx + 1], 'haiku');
  } finally {
    await server.shutdown();
  }
});

test('IDLE1 session is killed after idle timeout and re-spawns on next request', async () => {
  const server = await startServer({
    idleTimeoutMs: 300, // 300ms idle = dead
    sweepIntervalMs: 100, // sweep every 100ms
  });
  try {
    // First request — spawns session-default (spawn_count=1)
    const r1 = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-default', messages: [{ role: 'user', content: 'hi' }] },
    );
    assert.equal(r1.status, 200);
    const h1 = await request(server, { method: 'GET', path: '/healthz' });
    assert.equal(h1.body.sessions['session-default'].spawn_count, 1);
    const firstPid = h1.body.sessions['session-default'].pid;
    assert.ok(firstPid);

    // Wait past the idle threshold + one sweep cycle.
    await new Promise((r) => setTimeout(r, 600));

    // Session should be gone from the registry (/healthz no longer lists it)
    const h2 = await request(server, { method: 'GET', path: '/healthz' });
    assert.equal(
      h2.body.sessions['session-default'],
      undefined,
      'session expired and removed',
    );

    // Second request — should lazily spawn a NEW child
    const r2 = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-default', messages: [{ role: 'user', content: 'back?' }] },
    );
    assert.equal(r2.status, 200);
    const h3 = await request(server, { method: 'GET', path: '/healthz' });
    assert.ok(h3.body.sessions['session-default']);
    assert.notEqual(
      h3.body.sessions['session-default'].pid,
      firstPid,
      'new child has different pid',
    );
    assert.equal(h3.body.sessions['session-default'].spawn_count, 1);
  } finally {
    await server.shutdown();
  }
});

test('IDLE2 per-session timeout function: session-default stays warm, session-secondary expires', async () => {
  const server = await startServer({
    idleTimeoutMs: (id) => (id === 'session-secondary' ? 300 : 0),
    sweepIntervalMs: 100,
  });
  try {
    // Touch both sessions.
    await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-default', messages: [{ role: 'user', content: 'hi g' }] },
    );
    await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      { model: 'session-secondary', messages: [{ role: 'user', content: 'hi secondary' }] },
    );
    const h1 = await request(server, { method: 'GET', path: '/healthz' });
    assert.ok(h1.body.sessions['session-default']);
    assert.ok(h1.body.sessions['session-secondary']);

    // Wait past the idle threshold.
    await new Promise((r) => setTimeout(r, 600));

    const h2 = await request(server, { method: 'GET', path: '/healthz' });
    assert.ok(h2.body.sessions['session-default'], 'session-default still warm (no timeout)');
    assert.equal(
      h2.body.sessions['session-secondary'],
      undefined,
      'session-secondary expired',
    );
  } finally {
    await server.shutdown();
  }
});

test('STREAM1 stream:true → SSE with role, content, finish chunks, then [DONE]', async () => {
  const server = await startServer();
  try {
    const { port } = server.address();
    const body = JSON.stringify({
      model: 'cc-bridge/session-default',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const chunks = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${BEARER}`,
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers['content-type'] || '', /text\/event-stream/);
          const parts = [];
          res.on('data', (c) => parts.push(c));
          res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // Parse SSE events: lines starting with "data: "
    const events = chunks
      .split(/\n\n/)
      .map((block) => block.trim())
      .filter((b) => b.startsWith('data: '))
      .map((b) => b.slice(6));

    // Expect: role chunk, content chunk, finish chunk, [DONE]
    assert.equal(events[events.length - 1], '[DONE]', 'last event is [DONE]');
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    assert.ok(parsed.length >= 3, `at least 3 chunks (got ${parsed.length})`);
    assert.equal(parsed[0].choices[0].delta.role, 'assistant');
    const content = parsed
      .map((c) => c.choices[0].delta.content || '')
      .join('');
    assert.ok(content.length > 0, 'content delta has text');
    assert.equal(
      parsed[parsed.length - 1].choices[0].finish_reason,
      'stop',
      'last chunk has finish_reason=stop',
    );
    for (const p of parsed) {
      assert.equal(p.object, 'chat.completion.chunk');
    }
  } finally {
    await server.shutdown();
  }
});

test('STREAM3 stream:true → during long turn, keepalives are real chat.completion.chunk objects (not SSE comments)', async () => {
  // The OpenClaw gateway's llm-idle-timeout watchdog only resets on real
  // OpenAI chunks, not on SSE comment lines. If we send `: keepalive\n\n`
  // the gateway aborts the request mid-turn and retries in a loop. This
  // test forces a slow turn (1.2s) with a tight keepalive interval (200ms)
  // and asserts at least one empty-delta chunk lands BEFORE the real
  // assistant content.
  const server = await startServer({
    extraEnv: { FAKE_CLAUDE_TURN_DELAY: '1.2' },
    keepaliveIntervalMs: 200,
  });
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'cc-bridge/session-default',
        messages: [{ role: 'user', content: 'slow' }],
        stream: true,
      },
    );
    assert.equal(r.status, 200);
    const events = r.raw
      .split(/\n\n/)
      .map((b) => b.trim())
      .filter((b) => b.startsWith('data: '))
      .map((b) => b.slice(6));
    assert.ok(!r.raw.includes('\n: '), 'must NOT emit SSE comment lines');
    assert.equal(events[events.length - 1], '[DONE]');
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    // Empty-delta keepalive: an object-shaped chunk with delta={} and no
    // role/content. Must appear before the real role chunk.
    const firstRoleIdx = parsed.findIndex(
      (c) => c?.choices?.[0]?.delta?.role === 'assistant',
    );
    assert.ok(firstRoleIdx >= 0, 'role chunk present');
    const keepalivesBeforeRole = parsed.slice(0, firstRoleIdx).filter((c) => {
      const d = c?.choices?.[0]?.delta;
      return d && Object.keys(d).length === 0;
    });
    assert.ok(
      keepalivesBeforeRole.length >= 1,
      `expected ≥1 empty-delta keepalive before role chunk, got ${keepalivesBeforeRole.length}`,
    );
    // Every chunk must have the OpenAI-shape so the gateway parses it.
    for (const c of parsed) {
      assert.equal(c.object, 'chat.completion.chunk');
      assert.ok(Array.isArray(c.choices));
    }
  } finally {
    await server.shutdown();
  }
});

test('STREAM2 stream:true + upstream timeout → SSE error chunk, no [DONE]', async () => {
  // SSE headers are written (200 OK) the moment stream:true is requested, so
  // by the time the turn fails we cannot change the HTTP status. Previously
  // we wrote `data: [DONE]\n\n` and closed cleanly — which the gateway saw
  // as a successful empty completion (silent-failure bug: empty
  // completions were treated as success). Correct behavior: emit an
  // OpenAI-style `data: {"error":...}` chunk and end WITHOUT [DONE].
  const server = await startServer({
    claudeBin: STUB_HANG,
    turnTimeoutMs: 1000,
  });
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions', headers: authed },
      {
        model: 'cc-bridge/session-default',
        messages: [{ role: 'user', content: 'nothing' }],
        stream: true,
      },
    );
    assert.equal(r.status, 200);
    assert.ok(/"error"/.test(r.raw), `expected error chunk in body, got: ${r.raw}`);
    assert.ok(/upstream_(error|timeout_error)/.test(r.raw));
    assert.ok(!/\[DONE\]/.test(r.raw), 'must NOT emit [DONE] on upstream failure');
  } finally {
    await server.shutdown();
  }
});

test('unknown route → 404', async () => {
  const server = await startServer();
  try {
    const r = await request(server, {
      method: 'GET',
      path: '/nothing',
      headers: authed,
    });
    assert.equal(r.status, 404);
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Message batching integration tests
// ---------------------------------------------------------------------------

test('DBATCH1 two rapid messages to same session → first gets empty ack, second gets real reply', async () => {
  const server = await startServer({
    batchDebounceMs: 200,
    extraEnv: { FAKE_CLAUDE_TURN_DELAY: '0.1' },
  });
  try {
    const send = (msg) =>
      request(
        server,
        { method: 'POST', path: '/v1/chat/completions', headers: authed },
        { model: 'session-default', messages: [{ role: 'user', content: msg }] },
      );

    // Fire both requests without waiting.
    const [r1, r2] = await Promise.all([send('first'), send('second')]);

    // First request: empty ack (batched away).
    assert.equal(r1.status, 200);
    assert.equal(r1.body.choices[0].message.content, '');

    // Second request: real CC response with combined content.
    assert.equal(r2.status, 200);
    assert.ok(r2.body.choices[0].message.content.length > 0);
  } finally {
    await server.shutdown();
  }
});

test('DBATCH2 batching disabled (debounceMs=0) → all requests get real replies', async () => {
  const server = await startServer({
    batchDebounceMs: 0,
    extraEnv: { FAKE_CLAUDE_TURN_DELAY: '0.05' },
  });
  try {
    const send = (msg) =>
      request(
        server,
        { method: 'POST', path: '/v1/chat/completions', headers: authed },
        { model: 'session-default', messages: [{ role: 'user', content: msg }] },
      );

    const [r1, r2] = await Promise.all([send('a'), send('b')]);

    // Both should get real replies (no batching).
    assert.equal(r1.status, 200);
    assert.ok(r1.body.choices[0].message.content.length > 0);
    assert.equal(r2.status, 200);
    assert.ok(r2.body.choices[0].message.content.length > 0);
  } finally {
    await server.shutdown();
  }
});

test('DBATCH3 healthz shows batch config', async () => {
  const server = await startServer({ batchDebounceMs: 2000 });
  try {
    const r = await request(server, { method: 'GET', path: '/healthz' });
    assert.equal(r.status, 200);
    assert.equal(r.body.batch_debounce_ms, 2000);
    assert.equal(r.body.batch_pending, 0);
  } finally {
    await server.shutdown();
  }
});
