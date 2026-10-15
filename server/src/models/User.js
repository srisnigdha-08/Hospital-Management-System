const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class User extends Model {
  toSafeJSON() {
    const safe = { ...this.toJSON() };
    delete safe.passwordHash;
    delete safe.tokenVersion;
    return safe;
  }
}

User.init(
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'user_id' },
    roleId: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, field: 'role_id' },
    firstName: { type: DataTypes.STRING(60), allowNull: false, field: 'first_name' },
    lastName: { type: DataTypes.STRING(60), allowNull: false, field: 'last_name' },
    email: {
      type: DataTypes.STRING(120),
      allowNull: false,
      unique: true,
      validate: { isEmail: true },
    },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
    tokenVersion: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'token_version' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    avatarUrl: { type: DataTypes.STRING(255), allowNull: true, field: 'avatar_url' },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: 'last_login_at' },
  },
  { sequelize, modelName: 'User', tableName: 'users' }
);

module.exports = User;
