const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class Role extends Model {}

Role.init(
  {
    roleId: { type: DataTypes.TINYINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'role_id' },
    roleName: { type: DataTypes.STRING(30), allowNull: false, unique: true, field: 'role_name' },
    description: { type: DataTypes.STRING(255), allowNull: true },
  },
  { sequelize, modelName: 'Role', tableName: 'roles', updatedAt: false }
);

module.exports = Role;
