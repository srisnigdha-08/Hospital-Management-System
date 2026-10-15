export const APPOINTMENT_PAGE_SIZE = 100;
export const MAX_APPOINTMENT_PAGES = 100;
const PAGE_BATCH_SIZE = 4;

function localDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function parseLocalDate(value) {
  if (value instanceof Date) return localDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) throw new TypeError('Expected a local calendar date in YYYY-MM-DD format');

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    throw new TypeError('The calendar date is invalid');
  }
  return date;
}

export function formatLocalDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getAppointmentCalendarRange(view, selectedDate) {
  const date = parseLocalDate(selectedDate);
  let start;
  let endExclusive;

  if (view === 'day') {
    start = date;
    endExclusive = new Date(date);
    endExclusive.setDate(endExclusive.getDate() + 1);
  } else if (view === 'week') {
    start = new Date(date);
    start.setDate(start.getDate() - start.getDay());
    endExclusive = new Date(start);
    endExclusive.setDate(endExclusive.getDate() + 7);
  } else if (view === 'month') {
    const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const lastOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    start = new Date(firstOfMonth);
    start.setDate(start.getDate() - start.getDay());
    endExclusive = new Date(lastOfMonth);
    endExclusive.setDate(endExclusive.getDate() + (7 - endExclusive.getDay()));
  } else {
    throw new TypeError(`Unsupported calendar view: ${view}`);
  }

  return { start, endExclusive };
}

export function getAppointmentCalendarDays(view, selectedDate) {
  const { start, endExclusive } = getAppointmentCalendarRange(view, selectedDate);
  const days = [];
  const cursor = new Date(start);
  while (cursor < endExclusive) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function toAppointmentApiDateBounds({ start, endExclusive }) {
  return {
    from: start.toISOString(),
    to: new Date(endExclusive.getTime() - 1).toISOString(),
  };
}

export function canFilterAppointmentsByDoctor(roleName) {
  return roleName === 'admin' || roleName === 'receptionist';
}

export function buildAppointmentCalendarQuery(view, selectedDate, { status, doctorId, roleName } = {}) {
  const query = {
    ...toAppointmentApiDateBounds(getAppointmentCalendarRange(view, selectedDate)),
  };
  if (status) query.status = status;
  if (canFilterAppointmentsByDoctor(roleName) && doctorId) query.doctorId = doctorId;
  return query;
}

export function shiftAppointmentCalendarDate(selectedDate, view, amount) {
  const date = parseLocalDate(selectedDate);
  if (view === 'day' || view === 'week') {
    date.setDate(date.getDate() + amount * (view === 'day' ? 1 : 7));
    return formatLocalDateInput(date);
  }
  if (view !== 'month') throw new TypeError(`Unsupported calendar view: ${view}`);

  const dayOfMonth = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  const lastDayOfTargetMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return formatLocalDateInput(date);
}

export function getLocalDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Appointment has an invalid scheduled start');
  return formatLocalDateInput(date);
}

function abortError() {
  const error = new Error('The request was cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function readPage(response, expectedPage, resourceLabel) {
  const body = response?.data;
  const rows = body?.data;
  const meta = body?.meta;
  if (!Array.isArray(rows) || !meta) throw new Error(`The ${resourceLabel} service returned an invalid paginated response.`);
  if (meta.page !== expectedPage || meta.limit !== APPOINTMENT_PAGE_SIZE) {
    throw new Error(`The ${resourceLabel} pages were inconsistent. Refresh and try again.`);
  }
  if (!Number.isSafeInteger(meta.total) || meta.total < 0 || !Number.isSafeInteger(meta.totalPages) || meta.totalPages < 1) {
    throw new Error(`The ${resourceLabel} service returned invalid pagination metadata.`);
  }
  const expectedPages = Math.max(Math.ceil(meta.total / APPOINTMENT_PAGE_SIZE), 1);
  if (meta.totalPages !== expectedPages) {
    throw new Error(`The ${resourceLabel} pages were inconsistent. Refresh and try again.`);
  }
  const expectedRows = Math.max(0, Math.min(APPOINTMENT_PAGE_SIZE, meta.total - (expectedPage - 1) * APPOINTMENT_PAGE_SIZE));
  if (rows.length !== expectedRows) {
    throw new Error(`The ${resourceLabel} list changed while loading. Refresh and try again.`);
  }
  return { rows, meta };
}

export async function fetchAllPages(
  requestPage,
  params,
  { signal, getId = (row) => row?.appointmentId, resourceLabel = 'appointment' } = {}
) {
  throwIfAborted(signal);
  const first = readPage(
    await requestPage({ ...params, page: 1, limit: APPOINTMENT_PAGE_SIZE }, { signal }),
    1,
    resourceLabel
  );
  const { total, totalPages } = first.meta;
  if (totalPages > MAX_APPOINTMENT_PAGES) {
    throw new Error(`This ${resourceLabel} list is too large to load safely. Narrow the range and try again.`);
  }

  const rows = [...first.rows];
  const ids = new Set();
  for (const row of rows) {
    const id = getId(row);
    if (id == null || ids.has(String(id))) {
      throw new Error(`The ${resourceLabel} list contained duplicate or invalid entries. Refresh and try again.`);
    }
    ids.add(String(id));
  }

  for (let firstPage = 2; firstPage <= totalPages; firstPage += PAGE_BATCH_SIZE) {
    throwIfAborted(signal);
    const pageNumbers = Array.from(
      { length: Math.min(PAGE_BATCH_SIZE, totalPages - firstPage + 1) },
      (_, index) => firstPage + index
    );
    const pages = await Promise.all(pageNumbers.map(async (page) => ({
      page,
      result: readPage(
        await requestPage({ ...params, page, limit: APPOINTMENT_PAGE_SIZE }, { signal }),
        page,
        resourceLabel
      ),
    })));
    throwIfAborted(signal);

    for (const { page, result } of pages) {
      if (result.meta.total !== total || result.meta.totalPages !== totalPages) {
        throw new Error(`The ${resourceLabel} list changed while loading. Refresh and try again.`);
      }
      for (const row of result.rows) {
        const id = getId(row);
        if (id == null || ids.has(String(id))) {
          throw new Error(`The ${resourceLabel} list contained duplicate or invalid entries. Refresh and try again.`);
        }
        ids.add(String(id));
        rows.push(row);
      }
    }
  }

  if (rows.length !== total) {
    const plural = resourceLabel.endsWith('s') ? resourceLabel : `${resourceLabel}s`;
    throw new Error(`Not all ${plural} could be loaded. Refresh and try again.`);
  }
  return rows;
}
