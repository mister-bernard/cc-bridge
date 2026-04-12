#!/usr/bin/env node
// tests/smoke/live-multi-turn.mjs
//
// The load-bearing assumption of the whole cc-telegram-bridge architecture:
// does a single `claude -p --input-format stream-json --output-format
// stream-json` process actually handle multiple turns on the same stdin, or
// does it exit after the first result frame (making "persistent session"
// impossible)?
//
// This script sends two turns in sequence on the same process and asserts:
//   1. Two distinct result frames are received.
//   2. The second turn's session_id matches the first (same conversation).
//   3. The assistant remembers context from turn 1 in turn 2.
//
// Not part of `npm test`. Run manually: node tests/smoke/live-multi-turn.mjs

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
    'Reply with ONE short sentence maximum. No code blocks, no lists.',
];

console.log(`[smoke] spawning: ${CLAUDE_BIN} ${args.join(' ')}`);

const child = spawn(CLAUDE_BIN, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: '' },
});

const results = [];
let pendingResolve = null;
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    console.log(`[smoke] non-json: ${line.slice(0, 120)}`);
    return;
  }
  const type = msg.type;
  if (type === 'system' && msg.subtype === 'init') {
    console.log(`[smoke]   init session_id=${msg.session_id}`);
  } else if (type === 'assistant') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text') {
          console.log(`[smoke]   assistant: ${JSON.stringify(b.text).slice(0, 200)}`);
        }
      }
    }
  } else if (type === 'result') {
    const summary = {
      session_id: msg.session_id,
      is_error: msg.is_error,
      result: msg.result,
    };
    console.log(`[smoke]   result: ${JSON.stringify(summary)}`);
    results.push(summary);
    const r = pendingResolve;
    pendingResolve = null;
    if (r) r(summary);
  } else {
    console.log(`[smoke]   (ignored frame type=${type})`);
  }
});

child.stderr.on('data', (d) => process.stderr.write(`[claude stderr] ${d}`));

child.on('exit', (code, signal) => {
  console.log(`[smoke] claude exited code=${code} signal=${signal}`);
});

function sendTurn(content) {
  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    const frame = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    }) + '\n';
    console.log(`[smoke] >> turn: ${JSON.stringify(content)}`);
    child.stdin.write(frame);
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        reject(new Error('turn timeout'));
      }
    }, 90_000);
  });
}

(async () => {
  try {
    const r1 = await sendTurn("Remember this number: 57921. Just acknowledge.");
    console.log('[smoke] === turn 1 done ===');

    // Wait a tick, then send turn 2 on the same process.
    await new Promise((r) => setTimeout(r, 200));

    if (child.exitCode !== null || child.killed) {
      console.log('[smoke] FAIL — claude exited after first turn, persistent session NOT supported');
      process.exit(1);
    }

    const r2 = await sendTurn("What number did I ask you to remember?");
    console.log('[smoke] === turn 2 done ===');

    const sameSession = r1.session_id && r2.session_id && r1.session_id === r2.session_id;
    const remembered = typeof r2.result === 'string' && r2.result.includes('57921');
    const noErrors = !r1.is_error && !r2.is_error;

    console.log('---');
    console.log(`session ids match: ${sameSession} (t1=${r1.session_id} t2=${r2.session_id})`);
    console.log(`remembered number: ${remembered}`);
    console.log(`no errors:         ${noErrors}`);

    try { child.kill('SIGTERM'); } catch {}

    if (sameSession && remembered && noErrors) {
      console.log('[smoke] PASS — persistent multi-turn session works');
      process.exit(0);
    } else {
      console.log('[smoke] FAIL — persistence assertions missed');
      process.exit(2);
    }
  } catch (err) {
    console.error(`[smoke] ERROR: ${err.message}`);
    try { child.kill('SIGKILL'); } catch {}
    process.exit(3);
  }
})();
