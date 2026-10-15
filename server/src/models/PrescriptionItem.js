const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class PrescriptionItem extends Model {}

PrescriptionItem.init(
  {
    itemId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'item_id' },
    prescriptionId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'prescription_id' },
    medicineName: { type: DataTypes.STRING(150), allowNull: false, field: 'medicine_name' },
    dosage: { type: DataTypes.STRING(80), allowNull: false },
    frequency: { type: DataTypes.STRING(80), allowNull: false },
    duration: { type: DataTypes.STRING(80), allowNull: false },
    instructions: { type: DataTypes.STRING(255), allowNull: true },
  },
  { sequelize, modelName: 'PrescriptionItem', tableName: 'prescription_items', timestamps: false }
);

module.exports = PrescriptionItem;
