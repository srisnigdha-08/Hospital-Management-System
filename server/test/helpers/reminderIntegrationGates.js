'use strict';

const DEFAULT_GATE_TIMEOUT_MS = 30_000;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForGate(promise, timeoutMs = DEFAULT_GATE_TIMEOUT_MS) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reminder integration concurrency gate timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function barrier(participants, timeoutMs = DEFAULT_GATE_TIMEOUT_MS) {
  if (!Number.isInteger(participants) || participants < 1) throw new TypeError('Barrier participants must be a positive integer');
  let arrivals = 0;
  let timer;
  let resolveBarrier;
  let rejectBarrier;
  const released = new Promise((resolve, reject) => {
    resolveBarrier = resolve;
    rejectBarrier = reject;
  });
  return () => {
    arrivals += 1;
    if (arrivals > participants) throw new Error('Reminder integration barrier received an unexpected participant');
    if (arrivals === 1) {
      timer = setTimeout(() => rejectBarrier(new Error('Reminder integration concurrency barrier timed out')), timeoutMs);
    }
    if (arrivals === participants) {
      clearTimeout(timer);
      resolveBarrier();
    }
    return released;
  };
}

module.exports = { barrier, deferred, waitForGate };
