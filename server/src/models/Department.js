const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class Department extends Model {}

Department.init(
  {
    departmentId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'department_id' },
    name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    description: { type: DataTypes.STRING(500), allowNull: true },
    location: { type: DataTypes.STRING(120), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
  },
  { sequelize, modelName: 'Department', tableName: 'departments' }
);

module.exports = Department;
