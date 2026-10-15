const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class PasswordResetToken extends Model {}

PasswordResetToken.init(
  {
    tokenId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'token_id' },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'user_id' },
    tokenHash: { type: DataTypes.STRING(255), allowNull: false, field: 'token_hash' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    usedAt: { type: DataTypes.DATE, allowNull: true, field: 'used_at' },
  },
  { sequelize, modelName: 'PasswordResetToken', tableName: 'password_reset_tokens', updatedAt: false }
);

module.exports = PasswordResetToken;
