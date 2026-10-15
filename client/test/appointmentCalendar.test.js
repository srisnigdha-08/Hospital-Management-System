import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  APPOINTMENT_PAGE_SIZE,
  buildAppointmentCalendarQuery,
  canFilterAppointmentsByDoctor,
  fetchAllPages,
  formatLocalDateInput,
  getAppointmentCalendarDays,
  getAppointmentCalendarRange,
  shiftAppointmentCalendarDate,
  toAppointmentApiDateBounds,
} from '../src/utils/appointmentCalendar.js';

function dateKey(date) {
  return formatLocalDateInput(date);
}

function response(page, rows, total, totalPages = Math.max(Math.ceil(total / APPOINTMENT_PAGE_SIZE), 1)) {
  return {
    data: {
      data: rows,
      meta: { page, limit: APPOINTMENT_PAGE_SIZE, total, totalPages },
    },
  };
}

function appointment(appointmentId) {
  return { appointmentId, scheduledStart: '2026-04-15T10:00:00.000Z' };
}

test('day ranges use local midnight boundaries and adapt the inclusive API upper bound', () => {
  const range = getAppointmentCalendarRange('day', '2026-04-15');
  assert.equal(dateKey(range.start), '2026-04-15');
  assert.equal(dateKey(range.endExclusive), '2026-04-16');
  assert.equal(range.start.getHours(), 0);
  assert.equal(range.endExclusive.getHours(), 0);

  const bounds = toAppointmentApiDateBounds(range);
  assert.equal(new Date(bounds.from).getTime(), range.start.getTime());
  assert.equal(new Date(bounds.to).getTime(), range.endExclusive.getTime() - 1);
});

test('week and month ranges use local calendar boundaries, including adjacent month-grid dates', () => {
  const week = getAppointmentCalendarRange('week', '2026-01-01');
  assert.equal(dateKey(week.start), '2025-12-28');
  assert.equal(dateKey(week.endExclusive), '2026-01-04');

  const monthDays = getAppointmentCalendarDays('month', '2026-01-01');
  assert.equal(monthDays.length, 35);
  assert.equal(dateKey(monthDays[0]), '2025-12-28');
  assert.equal(dateKey(monthDays.at(-1)), '2026-01-31');
});

test('month navigation clamps the day when the destination month is shorter', () => {
  assert.equal(shiftAppointmentCalendarDate('2026-01-31', 'month', 1), '2026-02-28');
  assert.equal(shiftAppointmentCalendarDate('2024-01-31', 'month', 1), '2024-02-29');
  assert.equal(shiftAppointmentCalendarDate('2026-03-01', 'week', -1), '2026-02-22');
});

test('calendar query combines date/status filters and only includes doctor filtering for authorized staff roles', () => {
  const adminQuery = buildAppointmentCalendarQuery('day', '2026-04-15', {
    roleName: 'admin', status: 'confirmed', doctorId: '27',
  });
  assert.equal(adminQuery.status, 'confirmed');
  assert.equal(adminQuery.doctorId, '27');
  assert.equal(new Date(adminQuery.from).getHours(), 0);

  for (const roleName of ['doctor', 'patient']) {
    const query = buildAppointmentCalendarQuery('week', '2026-04-15', {
      roleName, status: 'scheduled', doctorId: '27',
    });
    assert.equal(query.status, 'scheduled');
    assert.equal('doctorId' in query, false);
  }
  assert.equal(canFilterAppointmentsByDoctor('receptionist'), true);
  assert.equal(canFilterAppointmentsByDoctor('doctor'), false);
});

test('calendar pagination collects every page in bounded batches', async () => {
  const allRows = Array.from({ length: 205 }, (_, index) => appointment(index + 1));
  const seenPages = [];
  const rows = await fetchAllPages(async ({ page }) => {
    seenPages.push(page);
    const start = (page - 1) * APPOINTMENT_PAGE_SIZE;
    return response(page, allRows.slice(start, start + APPOINTMENT_PAGE_SIZE), allRows.length);
  }, { from: '2026-04-01T00:00:00.000Z' });

  assert.equal(rows.length, 205);
  assert.deepEqual(seenPages.sort((a, b) => a - b), [1, 2, 3]);
});

test('empty results are valid but an empty expected final page is rejected as incomplete', async () => {
  const empty = await fetchAllPages(async () => response(1, [], 0));
  assert.deepEqual(empty, []);

  await assert.rejects(
    fetchAllPages(async ({ page }) => response(page, page === 1 ? Array.from({ length: 100 }, (_, i) => appointment(i + 1)) : [], 101)),
    /changed while loading/
  );
});

test('a later-page failure rejects the whole calendar load instead of returning partial rows', async () => {
  await assert.rejects(
    fetchAllPages(async ({ page }) => {
      if (page === 2) throw new Error('network failure');
      return response(page, Array.from({ length: 100 }, (_, i) => appointment(i + 1)), 201);
    }),
    /network failure/
  );
});

test('inconsistent pagination metadata, duplicate entries, and excessive page counts fail closed', async () => {
  await assert.rejects(
    fetchAllPages(async ({ page }) => response(page, page === 1 ? Array.from({ length: 100 }, (_, i) => appointment(i + 1)) : [appointment(101)], 101, page === 1 ? 2 : 3)),
    /inconsistent/
  );

  await assert.rejects(
    fetchAllPages(async ({ page }) => response(page, page === 1 ? Array.from({ length: 100 }, (_, i) => appointment(i + 1)) : [appointment(1)], 101)),
    /duplicate/
  );

  await assert.rejects(
    fetchAllPages(async () => response(1, Array.from({ length: 100 }, (_, i) => appointment(i + 1)), 10001)),
    /too large to load safely/
  );
});

test('shared paginator supports doctor IDs without treating them as appointment IDs', async () => {
  const rows = await fetchAllPages(
    async () => ({ data: { data: [{ doctorId: 4 }, { doctorId: 9 }], meta: { page: 1, limit: 100, total: 2, totalPages: 1 } } }),
    {},
    { getId: (doctor) => doctor.doctorId, resourceLabel: 'doctor' }
  );
  assert.deepEqual(rows.map((doctor) => doctor.doctorId), [4, 9]);
});

test('abort signal is forwarded to page requests and stops further pagination', async () => {
  const controller = new AbortController();
  const signals = [];
  await assert.rejects(
    fetchAllPages(async (params, { signal }) => {
      signals.push(signal);
      if (params.page === 1) {
        controller.abort();
        return response(1, Array.from({ length: 100 }, (_, i) => appointment(i + 1)), 101);
      }
      return response(2, [appointment(101)], 101);
    }, {}, { signal: controller.signal }),
    { name: 'AbortError' }
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0], controller.signal);
});

test('local day boundaries span 23 and 25 hours across daylight-saving transitions', () => {
  const moduleUrl = new URL('../src/utils/appointmentCalendar.js', import.meta.url).href;
  const script = `
    import { getAppointmentCalendarRange } from ${JSON.stringify(moduleUrl)};
    const spring = getAppointmentCalendarRange('day', '2026-03-08');
    const fall = getAppointmentCalendarRange('day', '2026-11-01');
    console.log(JSON.stringify({
      springHours: (spring.endExclusive - spring.start) / 3600000,
      fallHours: (fall.endExclusive - fall.start) / 3600000,
      springStartOffset: spring.start.getTimezoneOffset(),
      fallEndOffset: fall.endExclusive.getTimezoneOffset(),
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/New_York' },
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim());
  assert.equal(observed.springHours, 23);
  assert.equal(observed.fallHours, 25);
});
