const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class Notification extends Model {}

Notification.init(
  {
    notificationId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'notification_id' },
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'user_id' },
    type: {
      type: DataTypes.ENUM(
        'appointment_booked',
        'appointment_cancelled',
        'appointment_reminder',
        'appointment_rescheduled',
        'system'
      ),
      allowNull: false,
    },
    title: { type: DataTypes.STRING(150), allowNull: false },
    message: { type: DataTypes.STRING(500), allowNull: false },
    relatedAppointmentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'related_appointment_id' },
    appointmentReminderId: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      unique: 'uq_notifications_appointment_reminder',
      field: 'appointment_reminder_id',
    },
    reminderScheduledStartUtc: {
      type: DataTypes.DATE(3),
      allowNull: true,
      field: 'reminder_scheduled_start_utc',
    },
    isRead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_read' },
  },
  { sequelize, modelName: 'Notification', tableName: 'notifications', updatedAt: false }
);

module.exports = Notification;
