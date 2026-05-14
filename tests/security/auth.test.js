// tests/security/auth.test.js
//
// Bearer-auth gate for the cc-bridge daemon. The daemon is
// loopback-only, so this is "which local process is calling" — user identity
// (G vs. non-G) is enforced upstream by OpenClaw's bindings, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/daemon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_OK = path.resolve(__dirname, '../fake-claude');

const BEARER = 'sec-test-bearer';

function silentLog() {}

function startServer(opts = {}) {
  const server = createServer({
    bearer: BEARER,
    claudeBin: STUB_OK,
    claudeCwd: process.cwd(),
    model: '',
    systemPrompt: '',
    turnTimeoutMs: 3000,
    log: silentLog,
    ...opts,
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
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
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const validBody = {
  model: 'cc-bridge/session-default',
  messages: [{ role: 'user', content: 'hi' }],
};

test('SEC1 POST /v1/chat/completions without Authorization → 401', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      { method: 'POST', path: '/v1/chat/completions' },
      validBody,
    );
    assert.equal(r.status, 401);
    assert.equal(r.body.error.type, 'authentication_error');
  } finally {
    await server.shutdown();
  }
});

test('SEC2 POST with wrong bearer → 401', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: 'Bearer totally-wrong' },
      },
      validBody,
    );
    assert.equal(r.status, 401);
  } finally {
    await server.shutdown();
  }
});

test('SEC3 POST with malformed Authorization (no Bearer scheme) → 401', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: `NotBearer ${BEARER}` },
      },
      validBody,
    );
    assert.equal(r.status, 401);
  } finally {
    await server.shutdown();
  }
});

test('SEC4 GET /v1/models without bearer → 401', async () => {
  const server = await startServer();
  try {
    const r = await request(server, { method: 'GET', path: '/v1/models' });
    assert.equal(r.status, 401);
  } finally {
    await server.shutdown();
  }
});

test('SEC5 GET /healthz does NOT require bearer', async () => {
  const server = await startServer();
  try {
    const r = await request(server, { method: 'GET', path: '/healthz' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  } finally {
    await server.shutdown();
  }
});

test('SEC6 correct bearer is accepted end-to-end', async () => {
  const server = await startServer();
  try {
    const r = await request(
      server,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: `Bearer ${BEARER}` },
      },
      validBody,
    );
    assert.equal(r.status, 200);
  } finally {
    await server.shutdown();
  }
});
