const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class AppointmentReminder extends Model {}

AppointmentReminder.init(
  {
    appointmentReminderId: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
      field: 'appointment_reminder_id',
    },
    appointmentId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      unique: 'uq_appointment_reminders_appointment',
      field: 'appointment_id',
    },
    patientId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'patient_id' },
    idempotencyKey: {
      type: DataTypes.STRING(96),
      allowNull: false,
      unique: 'uq_appointment_reminders_idempotency',
      field: 'idempotency_key',
    },
    scheduledStartUtc: { type: DataTypes.DATE(3), allowNull: false, field: 'scheduled_start_utc' },
    dueAtUtc: { type: DataTypes.DATE(3), allowNull: false, field: 'due_at_utc' },
    nextAttemptAtUtc: { type: DataTypes.DATE(3), allowNull: false, field: 'next_attempt_at_utc' },
    scheduleRevision: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 1,
      field: 'schedule_revision',
    },
    state: {
      type: DataTypes.ENUM('pending', 'delivered', 'cancelled', 'skipped', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },
    attemptCount: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0, max: 5, isInt: true },
      field: 'attempt_count',
    },
    claimToken: { type: DataTypes.STRING(36), allowNull: true, field: 'claim_token' },
    leaseExpiresAtUtc: { type: DataTypes.DATE(3), allowNull: true, field: 'lease_expires_at_utc' },
    lastAttemptAtUtc: { type: DataTypes.DATE(3), allowNull: true, field: 'last_attempt_at_utc' },
    deliveredAtUtc: { type: DataTypes.DATE(3), allowNull: true, field: 'delivered_at_utc' },
    outcomeCode: { type: DataTypes.STRING(64), allowNull: true, field: 'outcome_code' },
    createdAt: { type: DataTypes.DATE(3), allowNull: false, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false, field: 'updated_at' },
  },
  {
    sequelize,
    modelName: 'AppointmentReminder',
    tableName: 'appointment_reminders',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  }
);

module.exports = AppointmentReminder;
