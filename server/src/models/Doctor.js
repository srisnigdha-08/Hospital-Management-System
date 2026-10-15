const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class Doctor extends Model {}

Doctor.init(
  {
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'doctor_id' },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true, field: 'user_id' },
    departmentId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'department_id' },
    specialization: { type: DataTypes.STRING(120), allowNull: false },
    qualification: { type: DataTypes.STRING(255), allowNull: false },
    experienceYears: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0, field: 'experience_years' },
    licenseNumber: { type: DataTypes.STRING(60), allowNull: false, unique: true, field: 'license_number' },
    consultationFee: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0, field: 'consultation_fee' },
    bio: { type: DataTypes.TEXT, allowNull: true },
    isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_available' },
  },
  { sequelize, modelName: 'Doctor', tableName: 'doctors' }
);

module.exports = Doctor;
