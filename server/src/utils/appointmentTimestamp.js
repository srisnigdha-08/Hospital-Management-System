const APPOINTMENT_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/i;

function parseAppointmentTimestamp(value) {
  if (typeof value !== 'string') {
    throw new TypeError('scheduledStart must be an ISO timestamp with an explicit timezone offset');
  }

  const match = APPOINTMENT_TIMESTAMP.exec(value);
  if (!match) {
    throw new TypeError('scheduledStart must be an ISO timestamp with an explicit timezone offset');
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', , zone, sign, offsetHourText, offsetMinuteText = '0'] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (
    year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
  ) {
    throw new TypeError('scheduledStart must be a valid calendar timestamp');
  }

  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const offsetHours = Number(offsetHourText);
    const offsetRemainder = Number(offsetMinuteText);
    if (offsetHours > 23 || offsetRemainder > 59) {
      throw new TypeError('scheduledStart must have a valid timezone offset');
    }
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (sign === '+' ? 1 : -1);
  }

  const localTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const utcTimestamp = localTimestamp - offsetMinutes * 60_000;
  const normalized = new Date(Math.floor(utcTimestamp / 1000) * 1000);
  const utcYear = normalized.getUTCFullYear();
  if (!Number.isFinite(normalized.getTime()) || utcYear < 1000 || utcYear > 9999) {
    throw new TypeError('scheduledStart is outside the supported database timestamp range');
  }

  return normalized;
}

module.exports = { parseAppointmentTimestamp };
