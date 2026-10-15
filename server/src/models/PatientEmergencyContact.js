const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class PatientEmergencyContact extends Model {}

PatientEmergencyContact.init(
  {
    contactId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'contact_id' },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'patient_id' },
    fullName: { type: DataTypes.STRING(120), allowNull: false, field: 'full_name' },
    relationship: { type: DataTypes.STRING(60), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: false },
    email: { type: DataTypes.STRING(120), allowNull: true },
    isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_primary' },
  },
  { sequelize, modelName: 'PatientEmergencyContact', tableName: 'patient_emergency_contacts', timestamps: false }
);

module.exports = PatientEmergencyContact;
