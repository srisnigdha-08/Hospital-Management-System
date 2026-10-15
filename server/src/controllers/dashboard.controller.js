const { Op, fn, col, literal } = require('sequelize');
const {
  sequelize, Patient, Doctor, Appointment, Department, AuditLog, User,
} = require('../models');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Cards + recent activity, tailored to the caller's role. */
const getSummary = asyncHandler(async (req, res) => {
  const { roleName, userId } = req.user;

  if (roleName === 'admin' || roleName === 'receptionist') {
    const [totalPatients, totalDoctors, todaysAppointments, upcomingAppointments, cancelledToday] = await Promise.all([
      Patient.count(),
      Doctor.count(),
      Appointment.count({ where: { scheduledStart: { [Op.between]: [startOfToday(), endOfToday()] } } }),
      Appointment.count({ where: { scheduledStart: { [Op.gt]: new Date() }, status: { [Op.in]: ['scheduled', 'confirmed'] } } }),
      Appointment.count({ where: { scheduledStart: { [Op.between]: [startOfToday(), endOfToday()] }, status: 'cancelled' } }),
    ]);

    const recentActivities = roleName === 'admin'
      ? await AuditLog.findAll({
        include: [{ model: User, attributes: ['firstName', 'lastName'] }],
        order: [['auditId', 'DESC']],
        limit: 10,
      })
      : [];

    return new ApiResponse(200, {
      cards: { totalPatients, totalDoctors, todaysAppointments, upcomingAppointments, cancelledToday },
      recentActivities,
    }).send(res);
  }

  if (roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId } });
    const doctorId = doctor ? doctor.doctorId : -1;

    const [todaysAppointments, upcomingAppointments, totalPatientsSeen, completedTotal] = await Promise.all([
      Appointment.count({ where: { doctorId, scheduledStart: { [Op.between]: [startOfToday(), endOfToday()] } } }),
      Appointment.count({ where: { doctorId, scheduledStart: { [Op.gt]: new Date() }, status: { [Op.in]: ['scheduled', 'confirmed'] } } }),
      Appointment.count({ where: { doctorId }, distinct: true, col: 'patient_id' }),
      Appointment.count({ where: { doctorId, status: 'completed' } }),
    ]);

    const recentActivities = await Appointment.findAll({
      where: { doctorId },
      include: [{
        model: Patient,
        attributes: ['patientId'],
        include: [{ model: User, attributes: ['firstName', 'lastName'] }],
      }],
      order: [['scheduledStart', 'DESC']],
      limit: 10,
    });

    return new ApiResponse(200, {
      cards: { todaysAppointments, upcomingAppointments, totalPatientsSeen, completedTotal },
      recentActivities,
    }).send(res);
  }

  // patient
  const patient = await Patient.findOne({ where: { userId } });
  const patientId = patient ? patient.patientId : -1;

  const [upcomingAppointments, pastAppointments, lastAppointment] = await Promise.all([
    Appointment.count({ where: { patientId, scheduledStart: { [Op.gt]: new Date() }, status: { [Op.in]: ['scheduled', 'confirmed'] } } }),
    Appointment.count({ where: { patientId, status: 'completed' } }),
    Appointment.findOne({
      where: { patientId, status: 'completed' },
      order: [['scheduledStart', 'DESC']],
      include: [{ model: Doctor, include: [{ model: User, attributes: ['firstName', 'lastName'] }] }],
    }),
  ]);

  const recentActivities = await Appointment.findAll({
    where: { patientId },
    include: [{ model: Doctor, include: [{ model: User, attributes: ['firstName', 'lastName'] }] }],
    order: [['scheduledStart', 'DESC']],
    limit: 10,
  });

  new ApiResponse(200, { cards: { upcomingAppointments, pastAppointments, lastAppointment }, recentActivities }).send(res);
});

/** Appointment volume per day for the last N days (role-scoped). */
const getAppointmentsTrend = asyncHandler(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 14, 90);
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const where = { scheduledStart: { [Op.gte]: since } };
  if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    where.doctorId = doctor ? doctor.doctorId : -1;
  } else if (req.user.roleName === 'patient') {
    const patient = await Patient.findOne({ where: { userId: req.user.userId } });
    where.patientId = patient ? patient.patientId : -1;
  }

  const rows = await Appointment.findAll({
    where,
    attributes: [[fn('DATE', col('scheduled_start')), 'day'], [fn('COUNT', col('appointment_id')), 'count']],
    group: [literal('day')],
    order: [literal('day ASC')],
    raw: true,
  });

  new ApiResponse(200, rows).send(res);
});

/** Appointment count grouped by department — admin/receptionist only. */
const getDepartmentDistribution = asyncHandler(async (req, res) => {
  const rows = await Appointment.findAll({
    attributes: [[col('Department.name'), 'department'], [fn('COUNT', col('Appointment.appointment_id')), 'count']],
    include: [{ model: Department, attributes: [] }],
    group: ['Department.department_id'],
    raw: true,
  });
  new ApiResponse(200, rows).send(res);
});

/** Appointment count per month for the last N months — admin/receptionist only. */
const getMonthlyStats = asyncHandler(async (req, res) => {
  const months = Math.min(Number(req.query.months) || 6, 24);
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const rows = await Appointment.findAll({
    where: { scheduledStart: { [Op.gte]: since } },
    attributes: [
      [fn('DATE_FORMAT', col('scheduled_start'), '%Y-%m'), 'month'],
      [fn('COUNT', col('appointment_id')), 'total'],
      [fn('SUM', literal("CASE WHEN status = 'completed' THEN 1 ELSE 0 END")), 'completed'],
      [fn('SUM', literal("CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END")), 'cancelled'],
    ],
    group: [literal('month')],
    order: [literal('month ASC')],
    raw: true,
  });

  new ApiResponse(200, rows).send(res);
});

module.exports = { getSummary, getAppointmentsTrend, getDepartmentDistribution, getMonthlyStats };
