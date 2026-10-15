'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ApiError = require('../src/utils/ApiError');
const ApiResponse = require('../src/utils/ApiResponse');
const { getPagination, buildMeta } = require('../src/utils/pagination');
const { createNotificationControllerHandlers } = require('../src/controllers/notification.controller.handlers');

function makeHarness() {
  const rows = [
    { notificationId: '11', userId: '100', isRead: false },
    { notificationId: '12', userId: '200', isRead: false },
  ];
  const calls = [];
  const Notification = {
    async findAndCountAll(options) {
      calls.push({ method: 'findAndCountAll', options });
      const matches = rows.filter((row) => row.userId === String(options.where.userId)
        && (options.where.isRead === undefined || row.isRead === options.where.isRead));
      return { rows: matches, count: matches.length };
    },
    async count(options) {
      calls.push({ method: 'count', options });
      return rows.filter((row) => row.userId === String(options.where.userId) && row.isRead === false).length;
    },
    async findOne(options) {
      calls.push({ method: 'findOne', options });
      return rows.find((row) => row.notificationId === String(options.where.notificationId)
        && row.userId === String(options.where.userId)) || null;
    },
    async update(values, options) {
      calls.push({ method: 'update', options });
      for (const row of rows) {
        if (row.userId === String(options.where.userId)
          && row.isRead === options.where.isRead) Object.assign(row, values);
      }
    },
  };
  const handlers = createNotificationControllerHandlers({
    Notification,
    ApiError,
    ApiResponse,
    asyncHandler: (handler) => handler,
    getPagination,
    buildMeta,
  });
  return { handlers, rows, calls };
}

function responseCapture() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

describe('notification ownership handlers (synthetic, database-free fakes)', () => {
  test('listing and unread count are scoped to the authenticated user', async () => {
    const h = makeHarness();
    const res = responseCapture();
    await h.handlers.listMyNotifications({ user: { userId: '100' }, query: { unreadOnly: 'true' } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.map((row) => row.notificationId), ['11']);
    assert.equal(res.body.meta.unreadCount, 1);
    assert.equal(h.calls[0].options.where.userId, '100');
    assert.equal(h.calls[1].options.where.userId, '100');
  });

  test('a read update using another user notification ID returns not found and leaves it unread', async () => {
    const h = makeHarness();
    const otherUserRow = h.rows.find((row) => row.notificationId === '12');
    await assert.rejects(h.handlers.markAsRead({
      user: { userId: '100' },
      params: { id: '12' },
    }, responseCapture()), (error) => error.statusCode === 404);

    assert.deepEqual(h.calls[0].options.where, { notificationId: '12', userId: '100' });
    assert.equal(otherUserRow.isRead, false);
  });

  test('mark-all updates only unread rows owned by the authenticated user', async () => {
    const h = makeHarness();
    const res = responseCapture();
    await h.handlers.markAllAsRead({ user: { userId: '100' } }, res);

    assert.deepEqual(h.calls[0].options.where, { userId: '100', isRead: false });
    assert.equal(h.rows[0].isRead, true);
    assert.equal(h.rows[1].isRead, false);
  });

  test('notification routes apply authentication before all handlers', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/notification.routes.js'), 'utf8');
    assert.match(source, /router\.use\(authenticate\)/);
    assert.match(source, /router\.get\('\/', controller\.listMyNotifications\)/);
    assert.match(source, /router\.patch\('\/:id\/read', controller\.markAsRead\)/);
    assert.match(source, /router\.patch\('\/read-all', controller\.markAllAsRead\)/);
  });
});
