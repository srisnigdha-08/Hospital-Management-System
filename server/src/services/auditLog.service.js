const { AuditLog } = require('../models');
const logger = require('../utils/logger');

async function record({ userId = null, action, entityType, entityId = null, ipAddress = null, metadata = null }) {
  try {
    await AuditLog.create({ userId, action, entityType, entityId, ipAddress, metadata });
  } catch (err) {
    // Auditing must never break the primary request flow.
    logger.error(`Failed to write audit log for action=${action}: ${err.message}`);
  }
}

module.exports = { record };
