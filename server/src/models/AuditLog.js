const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class AuditLog extends Model {}

AuditLog.init(
  {
    auditId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'audit_id' },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'user_id' },
    action: { type: DataTypes.STRING(80), allowNull: false },
    entityType: { type: DataTypes.STRING(60), allowNull: false, field: 'entity_type' },
    entityId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'entity_id' },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true, field: 'ip_address' },
    metadata: { type: DataTypes.JSON, allowNull: true },
  },
  { sequelize, modelName: 'AuditLog', tableName: 'audit_logs', updatedAt: false }
);

module.exports = AuditLog;
