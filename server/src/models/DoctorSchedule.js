const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class DoctorSchedule extends Model {}

DoctorSchedule.init(
  {
    scheduleId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'schedule_id' },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'doctor_id' },
    dayOfWeek: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, field: 'day_of_week' },
    startTime: { type: DataTypes.TIME, allowNull: false, field: 'start_time' },
    endTime: { type: DataTypes.TIME, allowNull: false, field: 'end_time' },
    slotMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 30, field: 'slot_minutes' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
  },
  { sequelize, modelName: 'DoctorSchedule', tableName: 'doctor_schedules', timestamps: false }
);

module.exports = DoctorSchedule;
