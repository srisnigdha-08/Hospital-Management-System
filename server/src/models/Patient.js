const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class Patient extends Model {}

Patient.init(
  {
    patientId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'patient_id' },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true, field: 'user_id' },
    dateOfBirth: { type: DataTypes.DATEONLY, allowNull: false, field: 'date_of_birth' },
    gender: { type: DataTypes.ENUM('male', 'female', 'other'), allowNull: false },
    bloodGroup: {
      type: DataTypes.ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'),
      allowNull: false,
      defaultValue: 'unknown',
      field: 'blood_group',
    },
    addressLine1: { type: DataTypes.STRING(150), allowNull: true, field: 'address_line1' },
    addressLine2: { type: DataTypes.STRING(150), allowNull: true, field: 'address_line2' },
    city: { type: DataTypes.STRING(80), allowNull: true },
    state: { type: DataTypes.STRING(80), allowNull: true },
    postalCode: { type: DataTypes.STRING(20), allowNull: true, field: 'postal_code' },
    country: { type: DataTypes.STRING(80), allowNull: true },
    registrationNumber: { type: DataTypes.STRING(30), allowNull: false, unique: true, field: 'registration_number' },
  },
  { sequelize, modelName: 'Patient', tableName: 'patients' }
);

module.exports = Patient;
