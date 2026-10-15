import { test as base, expect, chromium } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

const APP_ORIGIN = 'http://127.0.0.1:5194';
const FIXED_NOW = new Date('2026-04-15T16:00:00.000Z');
const SYNTHETIC_ACCESS = 'synthetic-browser-access-only';
const SYNTHETIC_REFRESH = 'synthetic-browser-refresh-only';
const CLINICAL_MARKER = 'SYNTHETIC_PRIVATE_CLINICAL_MARKER';

const test = base.extend({
  calendarContext: async ({}, use) => {
    const profileDir = await mkdtemp(join(tmpdir(), 'meridian-calendar-e2e-'));
    let context;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless: true,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        viewport: { width: 1280, height: 900 },
      });
      await use(context);
    } finally {
      await context?.close();
      const tempRoot = await realpath(tmpdir());
      const profile = await realpath(profileDir).catch(() => null);
      if (profile) {
        const relativeProfile = relative(tempRoot, profile);
        const isDirectGeneratedChild = dirname(profile) === tempRoot
          && basename(profile).startsWith('meridian-calendar-e2e-')
          && relativeProfile !== ''
          && !relativeProfile.startsWith(`..${sep}`)
          && !isAbsolute(relativeProfile)
          && !relativeProfile.includes(sep);
        if (isDirectGeneratedChild) await rm(profile, { recursive: true, force: true });
      }
    }
  },
  page: async ({ calendarContext }, use) => {
    const page = calendarContext.pages()[0] || await calendarContext.newPage();
    await use(page);
  },
});

test.afterEach(async ({ page }) => {
  for (const testedPage of page.context().pages()) {
    const audit = testedPage.calendarNetworkAudit;
    if (audit) expect(audit.unexpected, 'Unexpected or unmocked network requests').toEqual([]);
  }
});

function makeAppointment(
  appointmentId,
  scheduledStart,
  {
    status = 'scheduled',
    patientId = 12,
    doctorId = 27,
    patientName = `Synthetic Patient ${appointmentId}`,
    doctorName = 'Synthetic Doctor',
    reason = CLINICAL_MARKER,
  } = {}
) {
  const [patientFirstName, ...patientLast] = patientName.split(' ');
  const [doctorFirstName, ...doctorLast] = doctorName.split(' ');
  return {
    appointmentId,
    patientId,
    doctorId,
    scheduledStart,
    scheduledEnd: new Date(new Date(scheduledStart).getTime() + 30 * 60_000).toISOString(),
    status,
    reason,
    clinicalNotes: CLINICAL_MARKER,
    diagnosis: CLINICAL_MARKER,
    Patient: {
      patientId,
      User: { userId: patientId + 1000, firstName: patientFirstName, lastName: patientLast.join(' ') },
    },
    Doctor: {
      doctorId,
      User: { userId: doctorId + 2000, firstName: doctorFirstName, lastName: doctorLast.join(' ') },
    },
    Department: { name: 'Synthetic Department' },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function apiBody(data, meta = {}) {
  return { data, meta };
}

async function fulfillJson(route, body, status = 200) {
  try {
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
  } catch {
    // An aborted stale request may finish its delayed mock after the browser cancels it.
  }
}

function paginate(rows, params, defaultLimit = 100) {
  const page = Number(params.get('page') || 1);
  const limit = Number(params.get('limit') || defaultLimit);
  const total = rows.length;
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  return {
    data: rows.slice((page - 1) * limit, page * limit),
    meta: { page, limit, total, totalPages },
  };
}

function selectMockRows(state, params) {
  let rows = [...state.appointments];
  if (state.mockRoleScopes) {
    if (state.roleName === 'patient') rows = rows.filter((row) => row.patientId === 12);
    if (state.roleName === 'doctor') rows = rows.filter((row) => row.doctorId === 27);
  }
  const from = params.has('from') ? Date.parse(params.get('from')) : Number.NEGATIVE_INFINITY;
  const to = params.has('to') ? Date.parse(params.get('to')) : Number.POSITIVE_INFINITY;
  rows = rows.filter((row) => {
    const start = Date.parse(row.scheduledStart);
    return start >= from && start <= to;
  });
  if (params.has('status')) rows = rows.filter((row) => row.status === params.get('status'));
  if (params.has('doctorId')) rows = rows.filter((row) => String(row.doctorId) === params.get('doctorId'));
  return rows;
}

async function openCalendar(page, options = {}) {
  const state = {
    roleName: options.roleName || 'patient',
    appointments: options.appointments || [],
    doctors: options.doctors || [{ doctorId: 27, User: { firstName: 'Synthetic', lastName: 'Doctor' } }],
    mockRoleScopes: options.mockRoleScopes || false,
    failPageTwo: options.failPageTwo || false,
    slowFrom: options.slowFrom || null,
    slowDelayMs: options.slowDelayMs || 900,
    slowStarted: options.slowStarted || deferred(),
    requests: [],
    unexpected: [],
  };
  page.calendarNetworkAudit = state;

  await page.clock.install({ time: FIXED_NOW });
  await page.addInitScript((origin) => {
    if (window.location.origin !== origin) return;
    localStorage.setItem('hms_access_token', 'synthetic-browser-access-only');
    localStorage.setItem('hms_refresh_token', 'synthetic-browser-refresh-only');
  }, APP_ORIGIN);

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== APP_ORIGIN) {
      state.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const query = Object.fromEntries(url.searchParams.entries());
      state.requests.push({ method: request.method(), path: url.pathname, query });
      if (request.method() !== 'GET') {
        state.unexpected.push(`${request.method()} ${url.pathname}`);
        await fulfillJson(route, { message: 'Unexpected write request blocked by browser test' }, 599);
        return;
      }

      if (url.pathname === '/api/auth/me') {
        await fulfillJson(route, apiBody({
          user: {
            userId: 9001,
            firstName: 'Synthetic',
            lastName: 'Browser User',
            email: 'synthetic.user@example.test',
            roleName: state.roleName,
          },
          profile: state.roleName === 'patient' ? { patientId: 12 } : state.roleName === 'doctor' ? { doctorId: 27 } : null,
        }));
        return;
      }

      if (url.pathname === '/api/notifications') {
        await fulfillJson(route, apiBody([], { unreadCount: 0 }));
        return;
      }

      if (url.pathname === '/api/doctors') {
        const result = paginate(state.doctors, url.searchParams);
        await fulfillJson(route, apiBody(result.data, result.meta));
        return;
      }

      if (url.pathname === '/api/appointments') {
        const pageNumber = Number(url.searchParams.get('page') || 1);
        if (state.failPageTwo && pageNumber === 2) {
          await fulfillJson(route, { message: 'Synthetic later-page failure' }, 503);
          return;
        }
        if (state.slowFrom && url.searchParams.get('from') === state.slowFrom) {
          state.slowStarted.resolve();
          await new Promise((resolve) => setTimeout(resolve, state.slowDelayMs));
        }
        const result = paginate(selectMockRows(state, url.searchParams), url.searchParams);
        await fulfillJson(route, apiBody(result.data, result.meta));
        return;
      }

      state.unexpected.push(`${request.method()} ${url.pathname}`);
      await fulfillJson(route, { message: 'Unexpected API request blocked by browser test' }, 599);
      return;
    }

    const staticTypes = new Set(['document', 'script', 'stylesheet', 'font', 'image']);
    if (request.method() === 'GET' && staticTypes.has(request.resourceType())) {
      await route.continue();
      return;
    }

    state.unexpected.push(`${request.method()} ${url.pathname}`);
    await route.abort('blockedbyclient');
  });

  await page.goto(`${APP_ORIGIN}/appointments`);
  await expect(page.getByRole('group', { name: 'Appointment view' })).toBeVisible();
  await expect(page.locator('h2[aria-live="polite"]')).toBeVisible();
  await expect(page.getByText('Loading appointments…')).toHaveCount(0);
  return state;
}

function appointmentsRequest(state) {
  return state.requests.filter((request) => request.path === '/api/appointments').at(-1);
}

test('starts in Day view and switches among Day, Week, Month, and Table', async ({ page }) => {
  await openCalendar(page, {
    roleName: 'patient',
    appointments: [makeAppointment(1, '2026-04-15T16:00:00.000Z')],
  });
  const views = page.getByRole('group', { name: 'Appointment view' });
  await expect(views.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('article')).toHaveCount(1);

  await views.getByRole('button', { name: 'Week' }).click();
  await expect(page.getByRole('region', { name: 'Appointments by week' })).toBeVisible();
  await views.getByRole('button', { name: 'Month' }).click();
  await expect(page.getByRole('region', { name: 'Appointments by month' })).toBeVisible();
  await views.getByRole('button', { name: 'Table' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await views.getByRole('button', { name: 'Day' }).click();
  await expect(page.getByRole('region', { name: /Appointments for/ })).toBeVisible();
});

test('previous, next, today, and date picker navigate the selected local date', async ({ page }) => {
  await openCalendar(page);
  const heading = page.locator('h2[aria-live="polite"]');
  const datePicker = page.getByLabel('Go to date');
  await expect(datePicker).toHaveValue('2026-04-15');
  await expect(heading).toHaveText('Wednesday, April 15, 2026');

  await page.getByRole('button', { name: 'Previous period' }).click();
  await expect(datePicker).toHaveValue('2026-04-14');
  await expect(heading).toHaveText('Tuesday, April 14, 2026');
  await page.getByRole('button', { name: 'Next period' }).click();
  await expect(datePicker).toHaveValue('2026-04-15');

  await datePicker.fill('2026-04-20');
  await expect(heading).toHaveText('Monday, April 20, 2026');
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(datePicker).toHaveValue('2026-04-15');
});

test('date, status, and doctor filters are sent together for staff', async ({ page }) => {
  await openCalendar(page, {
    roleName: 'admin',
    appointments: [
      makeAppointment(1, '2026-04-20T15:00:00.000Z', { status: 'confirmed', doctorId: 27, patientName: 'Synthetic Allowed Patient' }),
      makeAppointment(2, '2026-04-20T16:00:00.000Z', { status: 'scheduled', doctorId: 27, patientName: 'Synthetic Scheduled Patient' }),
      makeAppointment(3, '2026-04-20T17:00:00.000Z', { status: 'confirmed', doctorId: 28, patientName: 'Synthetic Other Doctor Patient' }),
      makeAppointment(4, '2026-04-21T15:00:00.000Z', { status: 'confirmed', doctorId: 27, patientName: 'Synthetic Next Day Patient' }),
    ],
  });
  await page.getByLabel('Status').selectOption('confirmed');
  const doctorFilter = page.getByLabel('Doctor');
  await expect(doctorFilter).toBeEnabled();
  await doctorFilter.selectOption('27');
  await page.getByLabel('Go to date').fill('2026-04-20');

  await expect(page.getByText('Synthetic Allowed Patient')).toBeVisible();
  await expect(page.getByText('Synthetic Scheduled Patient')).toHaveCount(0);
  await expect(page.getByText('Synthetic Other Doctor Patient')).toHaveCount(0);
  await expect(page.getByText('Synthetic Next Day Patient')).toHaveCount(0);
  const query = appointmentsRequest(page.calendarNetworkAudit).query;
  expect(query.status).toBe('confirmed');
  expect(query.doctorId).toBe('27');
  expect(query.from).toBe('2026-04-20T04:00:00.000Z');
  expect(query.to).toBe('2026-04-21T03:59:59.999Z');
});

for (const roleName of ['admin', 'receptionist']) {
  test(`${roleName} sees the doctor filter`, async ({ page }) => {
    await openCalendar(page, { roleName });
    await expect(page.getByLabel('Doctor')).toBeVisible();
  });
}

for (const roleName of ['doctor', 'patient']) {
  test(`${roleName} does not see or send a doctor filter`, async ({ page }) => {
    await openCalendar(page, { roleName });
    await expect(page.getByLabel('Doctor')).toHaveCount(0);
    expect(appointmentsRequest(page.calendarNetworkAudit).query).not.toHaveProperty('doctorId');
  });
}

test('mocked patient and doctor API scopes render only the permitted synthetic appointments', async ({ page }) => {
  const scopedFixtures = [
    makeAppointment(1, '2026-04-15T16:00:00.000Z', { patientId: 12, doctorId: 27, patientName: 'Synthetic Own Patient', doctorName: 'Synthetic Assigned Doctor' }),
    makeAppointment(2, '2026-04-15T17:00:00.000Z', { patientId: 13, doctorId: 27, patientName: 'Synthetic Other Patient', doctorName: 'Synthetic Assigned Doctor' }),
    makeAppointment(3, '2026-04-15T18:00:00.000Z', { patientId: 14, doctorId: 28, patientName: 'Synthetic Other Doctor Patient', doctorName: 'Synthetic Other Doctor' }),
  ];

  await openCalendar(page, { roleName: 'patient', appointments: scopedFixtures, mockRoleScopes: true });
  await expect(page.getByText('Dr. Synthetic Assigned Doctor')).toBeVisible();
  await expect(page.getByText('Dr. Synthetic Other Doctor')).toHaveCount(0);
  expect(appointmentsRequest(page.calendarNetworkAudit).query).not.toHaveProperty('patientId');
  expect(appointmentsRequest(page.calendarNetworkAudit).query).not.toHaveProperty('doctorId');

  const doctorPage = await page.context().newPage();
  await openCalendar(doctorPage, { roleName: 'doctor', appointments: scopedFixtures, mockRoleScopes: true });
  await expect(doctorPage.getByText('Synthetic Own Patient')).toBeVisible();
  await expect(doctorPage.getByText('Synthetic Other Patient')).toBeVisible();
  await expect(doctorPage.getByText('Synthetic Other Doctor Patient')).toHaveCount(0);
  expect(appointmentsRequest(doctorPage.calendarNetworkAudit).query).not.toHaveProperty('doctorId');
  expect(appointmentsRequest(doctorPage.calendarNetworkAudit).query).not.toHaveProperty('patientId');
});

test('renders more than 100 synthetic appointments after fetching every page', async ({ page }) => {
  const rows = Array.from({ length: 205 }, (_, index) => makeAppointment(
    index + 1,
    new Date(Date.parse('2026-04-15T05:00:00.000Z') + index * 60_000).toISOString(),
    { patientName: `Synthetic Patient ${String(index + 1).padStart(3, '0')}` }
  ));
  const state = await openCalendar(page, { roleName: 'admin', appointments: rows });
  await expect(page.locator('article')).toHaveCount(205);
  await expect(page.getByText('Synthetic Patient 205')).toBeVisible();
  expect(state.requests.filter((request) => request.path === '/api/appointments').map((request) => request.query.page).sort()).toEqual(['1', '2', '3']);
});

test('later-page failure shows an error and retry loads the complete calendar', async ({ page }) => {
  const rows = Array.from({ length: 201 }, (_, index) => makeAppointment(
    index + 1,
    new Date(Date.parse('2026-04-15T05:00:00.000Z') + index * 60_000).toISOString()
  ));
  const state = await openCalendar(page, { roleName: 'patient', appointments: rows, failPageTwo: true });
  await expect(page.getByRole('alert')).toContainText('Synthetic later-page failure');
  await expect(page.getByRole('button', { name: 'Retry loading appointments' })).toBeVisible();

  state.failPageTwo = false;
  await page.getByRole('button', { name: 'Retry loading appointments' }).click();
  await expect(page.locator('article')).toHaveCount(201);
});

test('rapid date changes do not replace the latest results with a delayed stale response', async ({ page }) => {
  const slowStarted = deferred();
  const state = await openCalendar(page, {
    roleName: 'patient',
    appointments: [
      makeAppointment(1, '2026-04-16T15:00:00.000Z', {
        patientName: 'Synthetic Slow April 16',
        doctorName: 'Stale April 16 Doctor',
      }),
      makeAppointment(2, '2026-04-17T15:00:00.000Z', {
        patientName: 'Synthetic Fresh April 17',
        doctorName: 'Fresh April 17 Doctor',
      }),
    ],
    slowFrom: '2026-04-16T04:00:00.000Z',
    slowStarted,
    slowDelayMs: 900,
  });
  const datePicker = page.getByLabel('Go to date');
  await datePicker.fill('2026-04-16');
  await slowStarted.promise;
  await datePicker.fill('2026-04-17');
  await expect(page.getByText('Dr. Fresh April 17 Doctor')).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await expect(page.getByText('Dr. Stale April 16 Doctor')).toHaveCount(0);
  expect(state.requests.filter((request) => request.path === '/api/appointments').length).toBeGreaterThanOrEqual(3);
});

test('midnight and DST day bounds render local times and exclude the next midnight', async ({ page }) => {
  const rows = [
    makeAppointment(1, '2026-03-08T05:00:00.000Z', { patientName: 'Synthetic Spring Midnight' }),
    makeAppointment(2, '2026-03-08T06:30:00.000Z', { patientName: 'Synthetic Spring One Thirty' }),
    makeAppointment(3, '2026-03-09T04:00:00.000Z', { patientName: 'Synthetic After Spring Midnight' }),
    makeAppointment(4, '2026-11-01T05:30:00.000Z', { patientName: 'Synthetic Fall First One Thirty' }),
    makeAppointment(5, '2026-11-01T06:30:00.000Z', { patientName: 'Synthetic Fall Second One Thirty' }),
    makeAppointment(6, '2026-11-02T04:59:00.000Z', { patientName: 'Synthetic Fall Last Minute' }),
    makeAppointment(7, '2026-11-02T05:00:00.000Z', { patientName: 'Synthetic After Fall Midnight' }),
  ];
  await openCalendar(page, { roleName: 'patient', appointments: rows });
  const datePicker = page.getByLabel('Go to date');

  await datePicker.fill('2026-03-08');
  const springEntries = page.locator('article');
  await expect(springEntries).toHaveCount(2);
  await expect(springEntries.nth(0).locator('time')).toHaveText('12:00 AM');
  await expect(springEntries.nth(1).locator('time')).toHaveText('1:30 AM');
  const spring = appointmentsRequest(page.calendarNetworkAudit).query;
  expect(spring.from).toBe('2026-03-08T05:00:00.000Z');
  expect(spring.to).toBe('2026-03-09T03:59:59.999Z');
  expect(Date.parse(spring.to) - Date.parse(spring.from) + 1).toBe(23 * 60 * 60 * 1000);

  await datePicker.fill('2026-11-01');
  const fallEntries = page.locator('article');
  await expect(fallEntries).toHaveCount(3);
  const fall = appointmentsRequest(page.calendarNetworkAudit).query;
  expect(fall.from).toBe('2026-11-01T04:00:00.000Z');
  expect(fall.to).toBe('2026-11-02T04:59:59.999Z');
  expect(Date.parse(fall.to) - Date.parse(fall.from) + 1).toBe(25 * 60 * 60 * 1000);
  await expect(fallEntries.nth(0).locator('time')).toHaveText('1:30 AM');
  await expect(fallEntries.nth(1).locator('time')).toHaveText('1:30 AM');
  await expect(fallEntries.nth(2).locator('time')).toHaveText('11:59 PM');
});

test('calendar entries omit clinical details supplied in the synthetic API payload', async ({ page }) => {
  await openCalendar(page, {
    roleName: 'admin',
    appointments: [makeAppointment(1, '2026-04-15T16:00:00.000Z')],
  });
  const entry = page.locator('article').first();
  await expect(entry).toContainText('Synthetic Patient 1');
  await expect(entry).toContainText('Synthetic Doctor');
  await expect(page.getByText(CLINICAL_MARKER)).toHaveCount(0);
});

test('calendar remains usable at desktop and narrow viewports', async ({ page }, testInfo) => {
  await openCalendar(page, {
    roleName: 'patient',
    appointments: [makeAppointment(1, '2026-04-15T16:00:00.000Z')],
  });
  await page.getByRole('button', { name: 'Month' }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopWidth = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(desktopWidth.document).toBeLessThanOrEqual(desktopWidth.viewport);
  expect(desktopWidth.body).toBeLessThanOrEqual(desktopWidth.viewport);
  await page.screenshot({ path: testInfo.outputPath('appointment-calendar-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileWidth = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(mobileWidth.document).toBeLessThanOrEqual(mobileWidth.viewport);
  expect(mobileWidth.body).toBeLessThanOrEqual(mobileWidth.viewport);
  const scrollMetrics = await page.locator('[aria-label="Appointments by month"] .overflow-x-auto').evaluate((element) => ({
    client: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(scrollMetrics.content).toBeGreaterThan(scrollMetrics.client);
  await page.screenshot({ path: testInfo.outputPath('appointment-calendar-narrow.png'), fullPage: true });
});
