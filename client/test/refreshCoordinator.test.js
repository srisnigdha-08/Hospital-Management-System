import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceSessionGeneration,
  createRefreshCoordinator,
  isRefreshResultCurrent,
  SessionChangedError,
  shouldRefreshAfterUnauthorized,
} from '../src/api/refreshCoordinator.js';

const ACCESS = 'hms_access_token';
const REFRESH = 'hms_refresh_token';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function createLockManager() {
  let tail = Promise.resolve();
  return {
    request(_name, _options, callback) {
      const result = tail.then(callback);
      tail = result.catch(() => {});
      return result;
    },
  };
}

function setup({ lockManager = createLockManager(), storage = createStorage({
  [ACCESS]: 'old-access',
  [REFRESH]: 'old-refresh',
}), refreshRequest, onTokens = () => {} } = {}) {
  const refresh = createRefreshCoordinator({ lockManager, storage, refreshRequest, onTokens });
  return { refresh, storage, lockManager };
}

test('simultaneous tabs share the rotation and use the latest credentials', async () => {
  const response = deferred();
  const lockManager = createLockManager();
  const storage = createStorage({ [ACCESS]: 'old-access', [REFRESH]: 'old-refresh' });
  let calls = 0;
  const options = {
    lockManager,
    storage,
    refreshRequest: () => { calls += 1; return response.promise; },
    onTokens: () => {},
  };
  const tabA = createRefreshCoordinator(options);
  const tabB = createRefreshCoordinator(options);

  const resultA = tabA('old-refresh');
  const resultB = tabB('old-refresh');
  await new Promise((resolve) => setImmediate(resolve));
  response.resolve({ accessToken: 'new-access', refreshToken: 'new-refresh' });

  assert.deepEqual(await Promise.all([resultA, resultB]), [
    { accessToken: 'new-access', refreshToken: 'new-refresh', sessionGeneration: '0' },
    { accessToken: 'new-access', refreshToken: 'new-refresh', sessionGeneration: '0' },
  ]);
  assert.equal(calls, 1);
  assert.equal(storage.getItem(REFRESH), 'new-refresh');
});

test('the Web Lock serializes independent tab coordinators', async () => {
  const lockManager = createLockManager();
  const storage = createStorage({ [ACCESS]: 'a', [REFRESH]: 'r' });
  const gate = deferred();
  let entered = 0;
  const workA = lockManager.request('lock', { mode: 'exclusive' }, async () => {
    entered += 1;
    await gate.promise;
  });
  const workB = lockManager.request('lock', { mode: 'exclusive' }, async () => {
    entered += 1;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, 1);
  gate.resolve();
  await Promise.all([workA, workB]);
  assert.equal(entered, 2);
  assert.equal(storage.getItem(REFRESH), 'r');
});

test('the coordinator requests the shared origin lock in exclusive mode', async () => {
  let requested;
  const lockManager = {
    request: (name, options, callback) => {
      requested = { name, options };
      return Promise.resolve().then(callback);
    },
  };
  const { refresh } = setup({
    lockManager,
    refreshRequest: async () => ({ accessToken: 'a2', refreshToken: 'r2' }),
  });

  await refresh('old-refresh');
  assert.deepEqual(requested, {
    name: 'hms_auth_refresh_lock',
    options: { mode: 'exclusive' },
  });
});

test('a rejected lock owner releases ownership for the next tab', async () => {
  const lockManager = createLockManager();
  await assert.rejects(lockManager.request('lock', { mode: 'exclusive' }, async () => {
    throw new Error('owner failed');
  }), /owner failed/);
  assert.equal(await lockManager.request('lock', { mode: 'exclusive' }, async () => 'recovered'), 'recovered');
});

test('a refresh slower than the old lease duration remains exclusive', async () => {
  const lockManager = createLockManager();
  const first = deferred();
  let entered = 0;
  const owner = lockManager.request('lock', { mode: 'exclusive' }, async () => {
    entered += 1;
    await first.promise;
  });
  const waiter = lockManager.request('lock', { mode: 'exclusive' }, async () => {
    entered += 1;
  });

  await new Promise((resolve) => setTimeout(resolve, 7100));
  assert.equal(entered, 1);
  first.resolve();
  await Promise.all([owner, waiter]);
  assert.equal(entered, 2);
});

test('refresh failure releases the lock and permits a later attempt', async () => {
  let calls = 0;
  const { refresh, storage } = setup({
    refreshRequest: async () => {
      calls += 1;
      if (calls === 1) throw new Error('network failure');
      return { accessToken: 'next-access', refreshToken: 'next-refresh' };
    },
  });

  await assert.rejects(refresh('old-refresh'), /network failure/);
  storage.setItem(ACCESS, 'old-access');
  storage.setItem(REFRESH, 'old-refresh');
  assert.deepEqual(await refresh('old-refresh'), {
    accessToken: 'next-access',
    refreshToken: 'next-refresh',
    sessionGeneration: '0',
  });
  assert.equal(calls, 2);
});

test('logout during a refresh prevents returned credentials from being persisted', async () => {
  const request = deferred();
  const { refresh, storage } = setup({ refreshRequest: () => request.promise });
  const pending = refresh('old-refresh');
  await new Promise((resolve) => setImmediate(resolve));
  storage.removeItem(ACCESS);
  storage.removeItem(REFRESH);
  request.resolve({ accessToken: 'late-access', refreshToken: 'late-refresh' });

  await assert.rejects(pending, /Session changed/);
  assert.equal(storage.getItem(ACCESS), null);
  assert.equal(storage.getItem(REFRESH), null);
});

test('unauthorized requests refresh at most once and never refresh auth endpoints', () => {
  const base = { status: 401, retried: false, refreshToken: 'r', url: '/patients' };
  assert.equal(shouldRefreshAfterUnauthorized(base), true);
  assert.equal(shouldRefreshAfterUnauthorized({ ...base, retried: true }), false);
  assert.equal(shouldRefreshAfterUnauthorized({ ...base, url: '/auth/me' }), false);
  assert.equal(shouldRefreshAfterUnauthorized({ ...base, refreshToken: null }), false);
});

test('single-tab refresh rotates credentials once', async () => {
  let calls = 0;
  const saved = [];
  const { refresh } = setup({
    refreshRequest: async (token) => {
      calls += 1;
      assert.equal(token, 'old-refresh');
      return { accessToken: 'single-access', refreshToken: 'single-refresh' };
    },
    onTokens: (...tokens) => saved.push(tokens),
  });

  assert.deepEqual(await refresh('old-refresh'), {
    accessToken: 'single-access',
    refreshToken: 'single-refresh',
    sessionGeneration: '0',
  });
  assert.equal(calls, 1);
  assert.deepEqual(saved, [['single-access', 'single-refresh']]);
});

test('a completed refresh cannot dispatch a queued request after logout', async () => {
  const { refresh, storage } = setup({
    refreshRequest: async () => ({
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
    }),
  });
  const tokens = await refresh('old-refresh');

  assert.equal(isRefreshResultCurrent(storage, tokens), true);
  advanceSessionGeneration(storage);
  storage.removeItem(ACCESS);
  storage.removeItem(REFRESH);

  assert.equal(isRefreshResultCurrent(storage, tokens), false);
});

test('browsers without Web Locks fail closed without attempting refresh', async () => {
  let calls = 0;
  const { refresh } = setup({
    lockManager: null,
    refreshRequest: async () => { calls += 1; return {}; },
  });

  await assert.rejects(refresh('old-refresh'), /requires the Web Locks API/);
  assert.equal(calls, 0);
});

test('a failed old-session refresh does not invalidate a newer logged-in session', async () => {
  const request = deferred();
  const { refresh, storage } = setup({ refreshRequest: () => request.promise });
  const pending = refresh('old-refresh');
  await new Promise((resolve) => setImmediate(resolve));

  advanceSessionGeneration(storage);
  storage.setItem(ACCESS, 'new-login-access');
  storage.setItem(REFRESH, 'new-login-refresh');
  request.reject(new Error('late network failure'));

  await assert.rejects(pending, SessionChangedError);
  assert.equal(storage.getItem(ACCESS), 'new-login-access');
  assert.equal(storage.getItem(REFRESH), 'new-login-refresh');
});
