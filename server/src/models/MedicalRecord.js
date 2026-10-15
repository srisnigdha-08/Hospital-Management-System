const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class MedicalRecord extends Model {}

MedicalRecord.init(
  {
    recordId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'record_id' },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'patient_id' },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'doctor_id' },
    appointmentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, unique: true, field: 'appointment_id' },
    visitDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'visit_date' },
    symptoms: { type: DataTypes.TEXT, allowNull: true },
    diagnosis: { type: DataTypes.TEXT, allowNull: false },
    treatmentNotes: { type: DataTypes.TEXT, allowNull: true, field: 'treatment_notes' },
    followUpDate: { type: DataTypes.DATEONLY, allowNull: true, field: 'follow_up_date' },
  },
  { sequelize, modelName: 'MedicalRecord', tableName: 'medical_records' }
);

module.exports = MedicalRecord;
