#!/usr/bin/env node
// tests/smoke/live-single-turn.mjs
//
// Live Layer-B smoke: spawn the real `claude` CLI with the exact flags the
// daemon uses, send one user turn on stdin, assert we observe a well-formed
// assistant + result frame sequence. Used to validate the supervisor's
// stream-json parser against reality BEFORE writing openclaw.json config.
//
// Not part of `npm test` (no CI bandwidth for live Anthropic calls).
// Run manually: `node tests/smoke/live-single-turn.mjs`

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CLAUDE_BIN =
  process.env.CLAUDE_BIN || '/home/openclaw/.local/bin/claude';

const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
  '--model', 'sonnet',
  '--append-system-prompt',
    'Reply in exactly one word. Nothing else, just one word.',
];

console.log(`[smoke] spawning: ${CLAUDE_BIN} ${args.join(' ')}`);

const child = spawn(CLAUDE_BIN, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: '' }, // force OAuth
});

const frames = [];
let initSeen = false;
let resultSeen = false;
let assistantSeen = false;
const timeoutMs = 90_000;

// The real CLI does NOT emit anything on stdout until it receives a user
// frame on stdin. Write the user frame immediately.
const userFrame = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'Say hi' },
}) + '\n';
console.log(`[smoke] sending user frame: ${userFrame.trim()}`);
child.stdin.write(userFrame);

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`[smoke] non-json line: ${line.slice(0, 200)}`);
    return;
  }
  frames.push(msg);
  const type = msg.type;
  const subtype = msg.subtype || '';
  console.log(`[smoke] frame: type=${type}${subtype ? ` subtype=${subtype}` : ''}`);
  if (type === 'system' && subtype === 'init') {
    initSeen = true;
    console.log(`[smoke]   init session_id=${msg.session_id}`);
  } else if (type === 'assistant') {
    assistantSeen = true;
    const content = msg.message?.content;
    if (typeof content === 'string') {
      console.log(`[smoke]   assistant text (string): ${JSON.stringify(content).slice(0, 200)}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        console.log(`[smoke]   assistant block: ${JSON.stringify(block).slice(0, 200)}`);
      }
    }
  } else if (type === 'result') {
    resultSeen = true;
    console.log(`[smoke]   result.subtype=${msg.subtype} result.session_id=${msg.session_id || ''}`);
    console.log(`[smoke]   result.result=${JSON.stringify(msg.result || '').slice(0, 200)}`);
    // End the test — we've seen a full turn.
    try { child.kill('SIGTERM'); } catch {}
  }
});

child.stderr.on('data', (d) => {
  process.stderr.write(`[claude stderr] ${d}`);
});

const killTimer = setTimeout(() => {
  console.error(`[smoke] TIMEOUT after ${timeoutMs}ms — killing`);
  try { child.kill('SIGKILL'); } catch {}
}, timeoutMs);

child.on('exit', (code, signal) => {
  clearTimeout(killTimer);
  console.log(`[smoke] claude exited code=${code} signal=${signal}`);
  console.log('---');
  console.log(`init seen:      ${initSeen}`);
  console.log(`assistant seen: ${assistantSeen}`);
  console.log(`result seen:    ${resultSeen}`);
  console.log(`frame count:    ${frames.length}`);
  if (initSeen && assistantSeen && resultSeen) {
    console.log('[smoke] PASS');
    process.exit(0);
  } else {
    console.log('[smoke] FAIL — missing required frame(s)');
    console.log('---');
    console.log('frame type summary:');
    const types = {};
    for (const f of frames) {
      const k = `${f.type}${f.subtype ? '/' + f.subtype : ''}`;
      types[k] = (types[k] || 0) + 1;
    }
    console.log(JSON.stringify(types, null, 2));
    process.exit(1);
  }
});
