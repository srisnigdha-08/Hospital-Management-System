const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class RefreshToken extends Model {}

RefreshToken.init(
  {
    tokenId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'token_id' },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'user_id' },
    familyId: { type: DataTypes.STRING(64), allowNull: false, field: 'family_id' },
    tokenHash: { type: DataTypes.STRING(255), allowNull: false, field: 'token_hash' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
    createdByIp: { type: DataTypes.STRING(45), allowNull: true, field: 'created_by_ip' },
    replacedByTokenId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'replaced_by_token_id' },
  },
  {
    sequelize,
    modelName: 'RefreshToken',
    tableName: 'refresh_tokens',
    updatedAt: false,
    indexes: [
      { name: 'idx_rt_family', fields: ['family_id'] },
      { name: 'idx_rt_token_hash', fields: ['token_hash'] },
      { name: 'idx_rt_replaced_by', fields: ['replaced_by_token_id'] },
    ],
  }
);

module.exports = RefreshToken;
