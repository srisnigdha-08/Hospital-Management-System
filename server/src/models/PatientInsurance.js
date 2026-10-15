const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class PatientInsurance extends Model {}

PatientInsurance.init(
  {
    insuranceId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'insurance_id' },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'patient_id' },
    providerName: { type: DataTypes.STRING(120), allowNull: false, field: 'provider_name' },
    policyNumber: { type: DataTypes.STRING(80), allowNull: false, field: 'policy_number' },
    groupNumber: { type: DataTypes.STRING(80), allowNull: true, field: 'group_number' },
    validFrom: { type: DataTypes.DATEONLY, allowNull: true, field: 'valid_from' },
    validUntil: { type: DataTypes.DATEONLY, allowNull: true, field: 'valid_until' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
  },
  { sequelize, modelName: 'PatientInsurance', tableName: 'patient_insurance', timestamps: false }
);

module.exports = PatientInsurance;
