const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { validationResult } = require('express-validator');
const { parseAppointmentTimestamp } = require('../src/utils/appointmentTimestamp');
const { createRules, rescheduleRules } = require('../src/validators/appointment.validator');

async function timestampValidationErrors(chain, value) {
  const req = { body: { scheduledStart: value }, params: { id: '42' }, query: {} };
  await chain.run(req);
  return validationResult(req).array();
}

describe('appointment timestamp contract (database-free)', () => {
  test('accepts explicit UTC and numeric offsets and returns the same absolute instant', () => {
    assert.equal(parseAppointmentTimestamp('2026-06-02T00:00:00Z').toISOString(), '2026-06-02T00:00:00.000Z');
    assert.equal(parseAppointmentTimestamp('2026-06-02T05:30:00+05:30').toISOString(), '2026-06-02T00:00:00.000Z');
    assert.equal(parseAppointmentTimestamp('2026-06-01T19:00:00-0500').toISOString(), '2026-06-02T00:00:00.000Z');
    assert.equal(parseAppointmentTimestamp('2026-06-02T05:00:00+05').toISOString(), '2026-06-02T00:00:00.000Z');
  });

  test('rejects offset-free timestamps instead of interpreting them in server-local time', () => {
    for (const value of ['2026-06-02T00:00:00', '2026-06-02T00:00', '2026-06-02']) {
      assert.throws(() => parseAppointmentTimestamp(value), /explicit timezone offset/);
    }
  });

  test('rejects invalid calendar dates, clock values, and timezone offsets', () => {
    for (const value of [
      '2026-02-29T12:00:00Z',
      '2026-02-30T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T12:60:00Z',
      '2026-01-01T12:00:60Z',
      '2026-01-01T12:00:00+24:00',
      '2026-01-01T12:00:00+05:60',
      '0999-12-31T12:00:00Z',
    ]) {
      assert.throws(() => parseAppointmentTimestamp(value), TypeError, value);
    }
    assert.equal(parseAppointmentTimestamp('2028-02-29T12:00:00Z').toISOString(), '2028-02-29T12:00:00.000Z');
  });

  test('normalizes fractional input to the appointment column whole-second precision', () => {
    assert.equal(parseAppointmentTimestamp('2026-06-02T00:00:00.987654Z').toISOString(), '2026-06-02T00:00:00.000Z');
    assert.equal(parseAppointmentTimestamp('2026-06-02T00:00:01.000Z').toISOString(), '2026-06-02T00:00:01.000Z');
  });

  test('booking and rescheduling validators enforce the explicit-offset parser', async () => {
    for (const chain of [createRules[2], rescheduleRules[1]]) {
      assert.deepEqual(await timestampValidationErrors(chain, '2026-06-02T00:00:00Z'), []);
      assert.equal((await timestampValidationErrors(chain, '2026-06-02T00:00:00')).length, 1);
      assert.equal((await timestampValidationErrors(chain, '2026-02-30T00:00:00Z')).length, 1);
    }
  });

  test('normalizes midnight and daylight-saving-related values as absolute instants', () => {
    assert.equal(parseAppointmentTimestamp('2026-03-09T00:00:00-04:00').toISOString(), '2026-03-09T04:00:00.000Z');
    assert.equal(parseAppointmentTimestamp('2026-11-01T01:30:00-04:00').toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(parseAppointmentTimestamp('2026-11-01T01:30:00-05:00').toISOString(), '2026-11-01T06:30:00.000Z');
  });
});
