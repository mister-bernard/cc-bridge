// src/batcher.js
//
// MessageBatcher — debounces rapid-fire messages for the same session into a
// single combined prompt. Solves the "G sends 3 messages in 2 seconds and
// each one serializes as its own CC turn" problem.
//
// Usage:
//   const batcher = new MessageBatcher({ debounceMs: 1500 });
//   const { isPrimary, combinedText, batchSize } = await batcher.submit(sessionId, text);
//   if (isPrimary) {
//     // This request "owns" the batch — send combinedText to the supervisor
//   } else {
//     // Another request in the same batch will handle the turn — return an ack
//   }
//
// When debounceMs is 0 or falsy, batching is disabled and every submit()
// resolves immediately as primary with the original text.

export class MessageBatcher {
  constructor({ debounceMs = 1500, onLog = () => {} } = {}) {
    this.debounceMs = debounceMs;
    this.onLog = onLog;
    // sessionId → { messages: string[], resolvers: Function[], timer }
    this._pending = new Map();
  }

  submit(sessionId, text) {
    // Batching disabled — pass through immediately.
    if (!this.debounceMs || this.debounceMs <= 0) {
      return Promise.resolve({
        isPrimary: true,
        combinedText: text,
        batchSize: 1,
      });
    }

    return new Promise((resolve) => {
      let batch = this._pending.get(sessionId);
      if (!batch) {
        batch = { messages: [], resolvers: [], timer: null };
        this._pending.set(sessionId, batch);
      }

      batch.messages.push(text);
      batch.resolvers.push(resolve);

      // Reset debounce timer on every new message.
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = setTimeout(() => {
        this._pending.delete(sessionId);
        this._flush(sessionId, batch);
      }, this.debounceMs);
    });
  }

  _flush(sessionId, batch) {
    const n = batch.messages.length;

    if (n === 1) {
      // Single message — no batching overhead.
      batch.resolvers[0]({
        isPrimary: true,
        combinedText: batch.messages[0],
        batchSize: 1,
      });
      return;
    }

    this.onLog({
      evt: 'batcher.flush',
      session: sessionId,
      batch_size: n,
    });

    // Combine messages with clear separators so CC knows multiple messages
    // arrived. Number them so CC can address each.
    const combined = batch.messages
      .map((msg, i) => `[message ${i + 1} of ${n}]\n${msg}`)
      .join('\n\n');

    // Non-primary resolvers (all but last) get resolved immediately with
    // isPrimary=false. The daemon returns an empty ack for these.
    for (let i = 0; i < n - 1; i++) {
      batch.resolvers[i]({
        isPrimary: false,
        combinedText: null,
        batchSize: n,
      });
    }

    // Primary resolver (last message) gets the combined text to send to CC.
    batch.resolvers[n - 1]({
      isPrimary: true,
      combinedText: combined,
      batchSize: n,
    });
  }

  // How many sessions currently have pending batches.
  get pendingCount() {
    return this._pending.size;
  }

  // Cancel all pending batches (used during shutdown).
  clear() {
    for (const [, batch] of this._pending) {
      if (batch.timer) clearTimeout(batch.timer);
      for (const resolve of batch.resolvers) {
        resolve({ isPrimary: false, combinedText: null, batchSize: 0 });
      }
    }
    this._pending.clear();
  }
}
