const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class Appointment extends Model {}

Appointment.init(
  {
    appointmentId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'appointment_id' },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'patient_id' },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'doctor_id' },
    departmentId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'department_id' },
    scheduledStart: { type: DataTypes.DATE, allowNull: false, field: 'scheduled_start' },
    scheduledEnd: { type: DataTypes.DATE, allowNull: false, field: 'scheduled_end' },
    status: {
      type: DataTypes.ENUM('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'),
      allowNull: false,
      defaultValue: 'scheduled',
    },
    reason: { type: DataTypes.STRING(255), allowNull: true },
    cancellationReason: { type: DataTypes.STRING(255), allowNull: true, field: 'cancellation_reason' },
    bookedByUserId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'booked_by_user_id' },
  },
  { sequelize, modelName: 'Appointment', tableName: 'appointments' }
);

module.exports = Appointment;
