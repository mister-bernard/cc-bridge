// tests/unit/batcher.test.js
//
// Unit tests for the MessageBatcher debounce layer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MessageBatcher } from '../../src/batcher.js';

test('BATCH1 single message resolves as primary with original text', async () => {
  const batcher = new MessageBatcher({ debounceMs: 50 });
  const result = await batcher.submit('s1', 'hello');
  assert.equal(result.isPrimary, true);
  assert.equal(result.combinedText, 'hello');
  assert.equal(result.batchSize, 1);
});

test('BATCH2 two messages within debounce window get batched', async () => {
  const batcher = new MessageBatcher({ debounceMs: 100 });

  // Submit two messages rapidly.
  const p1 = batcher.submit('s1', 'msg one');
  const p2 = batcher.submit('s1', 'msg two');

  const [r1, r2] = await Promise.all([p1, p2]);

  // First message is non-primary (ack).
  assert.equal(r1.isPrimary, false);
  assert.equal(r1.combinedText, null);
  assert.equal(r1.batchSize, 2);

  // Second message is primary with combined text.
  assert.equal(r2.isPrimary, true);
  assert.equal(r2.batchSize, 2);
  assert.match(r2.combinedText, /msg one/);
  assert.match(r2.combinedText, /msg two/);
  assert.match(r2.combinedText, /\[message 1 of 2\]/);
  assert.match(r2.combinedText, /\[message 2 of 2\]/);
});

test('BATCH3 three messages batched — only last is primary', async () => {
  const batcher = new MessageBatcher({ debounceMs: 100 });

  const p1 = batcher.submit('s1', 'a');
  const p2 = batcher.submit('s1', 'b');
  const p3 = batcher.submit('s1', 'c');

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assert.equal(r1.isPrimary, false);
  assert.equal(r2.isPrimary, false);
  assert.equal(r3.isPrimary, true);
  assert.equal(r3.batchSize, 3);
  assert.match(r3.combinedText, /\[message 1 of 3\]/);
  assert.match(r3.combinedText, /\[message 3 of 3\]/);
});

test('BATCH4 different sessions batch independently', async () => {
  const batcher = new MessageBatcher({ debounceMs: 100 });

  const pA1 = batcher.submit('session-a', 'hello a');
  const pB1 = batcher.submit('session-b', 'hello b');
  const pA2 = batcher.submit('session-a', 'follow-up a');

  const [rA1, rB1, rA2] = await Promise.all([pA1, pB1, pA2]);

  // session-a: two messages batched
  assert.equal(rA1.isPrimary, false);
  assert.equal(rA2.isPrimary, true);
  assert.equal(rA2.batchSize, 2);

  // session-b: single message, primary
  assert.equal(rB1.isPrimary, true);
  assert.equal(rB1.batchSize, 1);
  assert.equal(rB1.combinedText, 'hello b');
});

test('BATCH5 debounceMs=0 disables batching — every submit is primary', async () => {
  const batcher = new MessageBatcher({ debounceMs: 0 });

  const r1 = await batcher.submit('s1', 'first');
  const r2 = await batcher.submit('s1', 'second');

  assert.equal(r1.isPrimary, true);
  assert.equal(r1.combinedText, 'first');
  assert.equal(r2.isPrimary, true);
  assert.equal(r2.combinedText, 'second');
});

test('BATCH6 messages after debounce fires start a new batch', async () => {
  const batcher = new MessageBatcher({ debounceMs: 50 });

  // First batch.
  const r1 = await batcher.submit('s1', 'batch1');
  assert.equal(r1.isPrimary, true);
  assert.equal(r1.batchSize, 1);

  // Wait for debounce to clear.
  await new Promise((r) => setTimeout(r, 80));

  // Second batch — should be independent.
  const r2 = await batcher.submit('s1', 'batch2');
  assert.equal(r2.isPrimary, true);
  assert.equal(r2.batchSize, 1);
  assert.equal(r2.combinedText, 'batch2');
});

test('BATCH7 clear() resolves all pending as non-primary', async () => {
  const batcher = new MessageBatcher({ debounceMs: 5000 }); // long debounce

  const p1 = batcher.submit('s1', 'will be cleared');
  const p2 = batcher.submit('s1', 'also cleared');

  // Don't await — clear immediately.
  batcher.clear();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.isPrimary, false);
  assert.equal(r2.isPrimary, false);
  assert.equal(batcher.pendingCount, 0);
});

test('BATCH8 pendingCount reflects active batches', async () => {
  const batcher = new MessageBatcher({ debounceMs: 200 });

  assert.equal(batcher.pendingCount, 0);

  const p1 = batcher.submit('s1', 'a');
  assert.equal(batcher.pendingCount, 1);

  const p2 = batcher.submit('s2', 'b');
  assert.equal(batcher.pendingCount, 2);

  // Same session — doesn't increase count.
  const p3 = batcher.submit('s1', 'c');
  assert.equal(batcher.pendingCount, 2);

  batcher.clear();
  await Promise.all([p1, p2, p3]);
  assert.equal(batcher.pendingCount, 0);
});
