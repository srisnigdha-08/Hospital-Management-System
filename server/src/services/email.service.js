const logger = require('../utils/logger');
const env = require('../config/env');

/**
 * Email delivery is not configured in this project. Never log message bodies:
 * they may contain password-reset links and other sensitive information.
 */
async function send({ to, subject, text }) {
  if (env.isProduction) {
    logger.warn('Email delivery is not configured; message was not delivered.');
    return { delivered: false, mocked: false };
  }
  logger.info('Email delivery is not configured; message was suppressed.');
  return { delivered: false, mocked: true };
}

module.exports = { send };
