const { body, param, query } = require('express-validator');
const { parseAppointmentTimestamp } = require('../utils/appointmentTimestamp');

function hasExplicitAppointmentTimezone(value) {
  try {
    parseAppointmentTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

const createRules = [
  body('patientId').optional().isInt().withMessage('A valid patient is required'),
  body('doctorId').isInt().withMessage('A valid doctor is required'),
  body('scheduledStart').custom(hasExplicitAppointmentTimezone)
    .withMessage('A valid start time with an explicit timezone offset is required'),
  body('durationMinutes').optional().isInt({ min: 5, max: 240 }),
  body('reason').optional().trim().isLength({ max: 255 }),
];

const rescheduleRules = [
  param('id').isInt().withMessage('Invalid appointment id'),
  body('scheduledStart').custom(hasExplicitAppointmentTimezone)
    .withMessage('A valid start time with an explicit timezone offset is required'),
  body('durationMinutes').optional().isInt({ min: 5, max: 240 }),
];

const cancelRules = [
  param('id').isInt().withMessage('Invalid appointment id'),
  body('reason').optional().trim().isLength({ max: 255 }),
];

const idParamRule = [param('id').isInt().withMessage('Invalid appointment id')];

const statusRules = [
  ...idParamRule,
  body('status').isIn(['confirmed', 'completed', 'no_show']).withMessage('Invalid appointment status'),
];

const listQueryRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']),
  query('doctorId').optional().isInt(),
  query('patientId').optional().isInt(),
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
];

const availabilityQueryRules = [
  query('doctorId').isInt().withMessage('A valid doctor is required'),
  query('date').isISO8601().withMessage('A valid date is required'),
];

module.exports = { createRules, rescheduleRules, cancelRules, idParamRule, statusRules, listQueryRules, availabilityQueryRules };
