const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class Prescription extends Model {}

Prescription.init(
  {
    prescriptionId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'prescription_id' },
    recordId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'record_id' },
    issuedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'issued_at' },
    notes: { type: DataTypes.STRING(500), allowNull: true },
  },
  { sequelize, modelName: 'Prescription', tableName: 'prescriptions', timestamps: false }
);

module.exports = Prescription;
