const multer = require('multer');
const { ValidationError, UniqueConstraintError, ForeignKeyConstraintError } = require('sequelize');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const env = require('../config/env');

/* eslint-disable no-unused-vars */
function errorHandler(err, req, res, next) {
  let error = err;

  // Normalize known Multer and Sequelize errors into ApiError so the response shape stays consistent.
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      error = ApiError.badRequest(`File size exceeds the limit of ${env.upload.maxMb}MB`);
    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      error = ApiError.badRequest(`Unexpected upload field "${error.field || 'file'}"`);
    } else {
      error = ApiError.badRequest(error.message);
    }
  } else if (error instanceof UniqueConstraintError) {
    const field = error.errors?.[0]?.path || 'field';
    error = ApiError.conflict(`A record with this ${field} already exists`);
  } else if (error instanceof ForeignKeyConstraintError) {
    error = ApiError.badRequest('This action references a record that does not exist or cannot be modified');
  } else if (error instanceof ValidationError) {
    const details = error.errors.map((e) => ({ field: e.path, message: e.message }));
    error = ApiError.badRequest('Validation failed', details);
  } else if (error.parent?.errno === 1205 || error.original?.code === 'ER_LOCK_WAIT_TIMEOUT') {
    error = ApiError.conflict('The requested resource is currently locked by another concurrent operation. Please try again.');
  } else if (error.parent?.errno === 1213 || error.original?.code === 'ER_LOCK_DEADLOCK') {
    error = ApiError.conflict('A concurrent conflict occurred while processing this request. Please try again.');
  } else if (!(error instanceof ApiError)) {
    logger.error(`Unhandled error: ${err.stack || err.message}`);
    error = ApiError.internal('Something went wrong');
  }

  if (error.statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${error.statusCode} ${error.message}`);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${error.statusCode} ${error.message}`);
  }

  res.status(error.statusCode).json({
    success: false,
    statusCode: error.statusCode,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}

module.exports = errorHandler;
