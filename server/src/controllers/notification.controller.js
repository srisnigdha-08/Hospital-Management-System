const { Notification } = require('../models');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const { getPagination, buildMeta } = require('../utils/pagination');
const { createNotificationControllerHandlers } = require('./notification.controller.handlers');

module.exports = createNotificationControllerHandlers({
  Notification,
  ApiError,
  ApiResponse,
  asyncHandler,
  getPagination,
  buildMeta,
});
