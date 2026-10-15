const { body, param, query } = require('express-validator');

const createRules = [
  body('patientId').isInt().withMessage('A valid patient is required'),
  body('doctorId').optional({ values: 'falsy' }).isInt().withMessage('Valid doctor ID is required'),
  body('appointmentId').optional({ values: 'falsy' }).isInt(),
  body('visitDate').isISO8601().withMessage('A valid visit date is required'),
  body('diagnosis').trim().notEmpty().withMessage('Diagnosis is required'),
  body('symptoms').optional().trim(),
  body('treatmentNotes').optional().trim(),
  body('followUpDate').optional({ values: 'falsy' }).isISO8601(),
  body('prescriptionItems').optional().isArray(),
  body('prescriptionItems.*.medicineName').optional().trim().notEmpty(),
  body('prescriptionItems.*.dosage').optional().trim().notEmpty(),
  body('prescriptionItems.*.frequency').optional().trim().notEmpty(),
  body('prescriptionItems.*.duration').optional().trim().notEmpty(),
];

const updateRules = [
  param('id').isInt().withMessage('Invalid record id'),
  body('diagnosis').optional().trim().notEmpty(),
  body('symptoms').optional().trim(),
  body('treatmentNotes').optional().trim(),
  body('followUpDate').optional({ values: 'falsy' }).isISO8601(),
];

const idParamRule = [param('id').isInt().withMessage('Invalid record id')];

const listQueryRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('patientId').optional().isInt(),
  query('doctorId').optional().isInt(),
];

const attachmentParamRules = [
  param('id').isInt().withMessage('Invalid record id'),
  param('attachmentId').isInt().withMessage('Invalid attachment id'),
];

module.exports = { createRules, updateRules, idParamRule, listQueryRules, attachmentParamRules };
