#!/usr/bin/env node
// tests/smoke/live-daemon.mjs
//
// End-to-end: start the daemon pointed at the REAL claude binary, hit
// /v1/chat/completions with two sequential requests on the same session id,
// assert both return 200 and the second remembers context from the first.
//
// Proves: daemon + supervisor + real stream-json + persistent session all
// compose correctly. Last smoke before wiring openclaw.json.

import http from 'node:http';
import { createServer } from '../../src/daemon.js';

const BEARER = 'smoke-test-bearer';

function request(server, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${BEARER}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, body: json, raw });
        });
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const server = createServer({
    bearer: BEARER,
    claudeBin: '/home/openclaw/.local/bin/claude',
    claudeCwd: '/tmp',
    model: 'sonnet',
    systemPrompt: 'Reply with ONE short sentence maximum. No code, no lists.',
    turnTimeoutMs: 90_000,
    log: (ev) => {
      // Only print high-signal events.
      if (ev.evt === 'claude.spawn' || ev.evt === 'claude.ready' ||
          ev.evt === 'claude.exit' || ev.lvl === 'error') {
        console.log(`[daemon]`, JSON.stringify(ev));
      }
    },
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log(`[smoke] daemon listening on ${JSON.stringify(server.address())}`);

  try {
    console.log('[smoke] >> turn 1: set number');
    const r1 = await request(server, {
      model: 'cc-bridge/session-g',
      messages: [{ role: 'user', content: 'Remember this number: 81234. Just acknowledge.' }],
      user: 'telegram:39172309',
    });
    console.log(`[smoke]   turn 1: status=${r1.status} content=${JSON.stringify(r1.body?.choices?.[0]?.message?.content || '').slice(0, 200)}`);
    if (r1.status !== 200) throw new Error(`turn 1 status ${r1.status}: ${r1.raw}`);

    console.log('[smoke] >> turn 2: recall');
    const r2 = await request(server, {
      model: 'cc-bridge/session-g',
      messages: [{ role: 'user', content: 'What number did I ask you to remember?' }],
      user: 'telegram:39172309',
    });
    console.log(`[smoke]   turn 2: status=${r2.status} content=${JSON.stringify(r2.body?.choices?.[0]?.message?.content || '').slice(0, 200)}`);
    if (r2.status !== 200) throw new Error(`turn 2 status ${r2.status}: ${r2.raw}`);

    const content1 = r1.body.choices[0].message.content;
    const content2 = r2.body.choices[0].message.content;
    const remembered = content2.includes('81234');

    console.log('---');
    console.log(`turn 1 ok:    ${r1.status === 200}`);
    console.log(`turn 2 ok:    ${r2.status === 200}`);
    console.log(`remembered:   ${remembered}`);

    // Check healthz while the session is alive.
    const healthReq = await new Promise((resolve, reject) => {
      const { port } = server.address();
      http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      }).on('error', reject);
    });
    console.log(`healthz:      ${healthReq.status} sessions=${JSON.stringify(healthReq.body.sessions)}`);

    if (remembered) {
      console.log('[smoke] PASS — daemon end-to-end with persistent CC session works');
      await server.shutdown();
      process.exit(0);
    } else {
      console.log('[smoke] FAIL — turn 2 did not recall the number');
      await server.shutdown();
      process.exit(1);
    }
  } catch (err) {
    console.error(`[smoke] ERROR: ${err.message}`);
    try { await server.shutdown(); } catch {}
    process.exit(2);
  }
})();
