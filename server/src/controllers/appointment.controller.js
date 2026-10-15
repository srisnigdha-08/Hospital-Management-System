const { Op, Transaction } = require('sequelize');
const {
  sequelize, Appointment, AppointmentReminder, Patient, Doctor, User, Department, DoctorSchedule,
} = require('../models');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const auditLog = require('../services/auditLog.service');
const notificationService = require('../services/notification.service');
const { createAppointmentReminderLifecycle } = require('../services/appointmentReminderLifecycle.service');
const { getPagination, buildMeta } = require('../utils/pagination');
const { parseAppointmentTimestamp } = require('../utils/appointmentTimestamp');

const appointmentReminderLifecycle = createAppointmentReminderLifecycle({
  AppointmentReminder,
  Patient,
});

const TERMINAL_APPOINTMENT_STATUSES = ['cancelled', 'completed', 'no_show'];

function getAppointmentIncludes(roleName) {
  const doctorView = roleName === 'doctor';
  const limitedPatientView = doctorView || roleName === 'patient';
  return [
    {
      model: Patient,
      ...(limitedPatientView && { attributes: ['patientId'] }),
      include: [{
        model: User,
        attributes: limitedPatientView ? ['firstName', 'lastName'] : ['userId', 'firstName', 'lastName', 'email', 'phone'],
      }],
    },
    {
      model: Doctor,
      include: [{ model: User, attributes: ['userId', 'firstName', 'lastName', 'email'] }, { model: Department }],
    },
    { model: Department },
  ];
}

/** Executes an action with bounded retries on transient database deadlocks. */
async function executeWithRetry(action, maxRetries = 2) {
  let attempt = 0;
  while (true) {
    try {
      return await action();
    } catch (err) {
      const isDeadlock =
        err?.parent?.errno === 1213 ||
        err?.original?.code === 'ER_LOCK_DEADLOCK' ||
        (err?.name === 'SequelizeDatabaseError' && /deadlock/i.test(err.message));
      if (isDeadlock && attempt < maxRetries) {
        attempt += 1;
        logger.warn(`Database deadlock encountered during appointment booking/rescheduling. Retrying attempt ${attempt}/${maxRetries}...`);
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 40)));
        continue;
      }
      const isLockTimeout =
        err?.parent?.errno === 1205 ||
        err?.original?.code === 'ER_LOCK_WAIT_TIMEOUT' ||
        (err?.name === 'SequelizeDatabaseError' && /lock wait timeout/i.test(err.message));
      if (isLockTimeout) {
        throw ApiError.conflict('The appointment slot is currently locked by another concurrent operation. Please try again.');
      }
      throw err;
    }
  }
}

async function hasConflict(doctorId, start, end, excludeAppointmentId = null, transaction = null) {
  const where = {
    doctorId,
    status: { [Op.notIn]: ['cancelled', 'no_show'] },
    scheduledStart: { [Op.lt]: end },
    scheduledEnd: { [Op.gt]: start },
  };
  if (excludeAppointmentId) where.appointmentId = { [Op.ne]: excludeAppointmentId };
  const conflict = await Appointment.findOne({
    where,
    transaction: transaction || undefined,
  });
  return Boolean(conflict);
}

/** Computes free slots for a doctor on a given calendar date from their weekly schedule. */
const getAvailableSlots = asyncHandler(async (req, res) => {
  const { doctorId, date } = req.query;

  const doctor = await Doctor.findByPk(doctorId);
  if (!doctor) throw ApiError.notFound('Doctor not found');

  const targetDate = new Date(`${date}T00:00:00`);
  const dayOfWeek = targetDate.getDay();

  const schedules = await DoctorSchedule.findAll({ where: { doctorId, dayOfWeek, isActive: true } });
  if (!schedules.length) return new ApiResponse(200, { slots: [] }).send(res);

  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59`);
  const bookedAppointments = await Appointment.findAll({
    where: {
      doctorId,
      status: { [Op.notIn]: ['cancelled', 'no_show'] },
      scheduledStart: { [Op.between]: [dayStart, dayEnd] },
    },
  });

  const slots = [];
  for (const schedule of schedules) {
    const [startH, startM] = schedule.startTime.split(':').map(Number);
    const [endH, endM] = schedule.endTime.split(':').map(Number);
    let cursor = new Date(targetDate);
    cursor.setHours(startH, startM, 0, 0);
    const windowEnd = new Date(targetDate);
    windowEnd.setHours(endH, endM, 0, 0);

    while (cursor < windowEnd) {
      const slotEnd = new Date(cursor.getTime() + schedule.slotMinutes * 60000);
      if (slotEnd > windowEnd) break;

      const isBooked = bookedAppointments.some(
        (a) => new Date(a.scheduledStart) < slotEnd && new Date(a.scheduledEnd) > cursor
      );
      const isPast = cursor < new Date();

      if (!isBooked && !isPast) {
        slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
      }
      cursor = slotEnd;
    }
  }

  new ApiResponse(200, { slots }).send(res);
});

const createAppointment = asyncHandler(async (req, res) => {
  const { doctorId, scheduledStart, durationMinutes, reason } = req.body;
  let { patientId } = req.body;

  // Patients may only ever book on their own behalf, regardless of what the client sends.
  if (req.user.roleName === 'patient') {
    const own = await Patient.findOne({ where: { userId: req.user.userId } });
    if (!own) throw ApiError.forbidden('No patient profile is linked to this account');
    patientId = own.patientId;
  } else if (!patientId) {
    throw ApiError.badRequest('patientId is required');
  }

  const patient = await Patient.findByPk(patientId);
  if (!patient) throw ApiError.notFound('Patient not found');

  const start = parseAppointmentTimestamp(scheduledStart);
  if (start < new Date()) throw ApiError.badRequest('Cannot book an appointment in the past');

  const end = new Date(start.getTime() + (durationMinutes || 30) * 60000);

  const appointment = await executeWithRetry(async () => {
    return sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (t) => {
        // 1. Lock the existing doctor row as a stable lock target to serialize bookings for this doctor
        const doctor = await Doctor.findByPk(doctorId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!doctor) throw ApiError.notFound('Doctor not found');
        if (!doctor.isAvailable) throw ApiError.badRequest('This doctor is not currently accepting appointments');

        // 2. Validate conflict under the doctor lock
        if (await hasConflict(doctorId, start, end, null, t)) {
          throw ApiError.conflict('This doctor already has an appointment in that time slot');
        }

        // 3. Atomically create appointment
        const createdAppointment = await Appointment.create(
          {
            patientId,
            doctorId,
            departmentId: doctor.departmentId,
            scheduledStart: start,
            scheduledEnd: end,
            reason,
            status: 'scheduled',
            bookedByUserId: req.user.userId,
          },
          { transaction: t }
        );
        await appointmentReminderLifecycle.enrollCreatedAppointment(createdAppointment, t);
        return createdAppointment;
      }
    );
  });

  // Post-commit side effects: notifications and audit log
  try {
    const doctor = await Doctor.findByPk(doctorId);
    const doctorUser = await User.findByPk(doctor.userId);
    await Promise.all([
      notificationService.notifyAppointmentBooked(appointment, patient.userId),
      notificationService.notifyAppointmentBooked(appointment, doctorUser.userId),
    ]);
  } catch (notifyErr) {
    logger.warn(`Failed to send appointment booked notification: ${notifyErr.message}`);
  }

  try {
    await auditLog.record({
      userId: req.user.userId,
      action: 'CREATE_APPOINTMENT',
      entityType: 'Appointment',
      entityId: appointment.appointmentId,
      ipAddress: req.ip,
    });
  } catch (auditErr) {
    logger.warn(`Failed to record audit log for appointment creation: ${auditErr.message}`);
  }

  const full = await Appointment.findByPk(appointment.appointmentId, { include: getAppointmentIncludes(req.user.roleName) });
  new ApiResponse(201, full, 'Appointment booked').send(res);
});

const listAppointments = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const where = {};

  if (req.query.status) where.status = req.query.status;
  if (req.query.from || req.query.to) {
    where.scheduledStart = {};
    if (req.query.from) where.scheduledStart[Op.gte] = new Date(req.query.from);
    if (req.query.to) where.scheduledStart[Op.lte] = new Date(req.query.to);
  }

  // Scope by role: patients and doctors only ever see their own appointments.
  if (req.user.roleName === 'patient') {
    const patient = await Patient.findOne({ where: { userId: req.user.userId } });
    where.patientId = patient ? patient.patientId : -1;
  } else if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    where.doctorId = doctor ? doctor.doctorId : -1;
  } else {
    if (req.query.doctorId) where.doctorId = req.query.doctorId;
    if (req.query.patientId) where.patientId = req.query.patientId;
  }

  const { rows, count } = await Appointment.findAndCountAll({
    where,
    include: getAppointmentIncludes(req.user.roleName),
    limit,
    offset,
    order: [['scheduledStart', 'DESC']],
    distinct: true,
  });

  new ApiResponse(200, rows, 'OK', buildMeta({ page, limit, total: count })).send(res);
});

/**
 * Verifies that the authenticated caller has permission to view this appointment.
 * - Admin and receptionist may access any appointment.
 * - Patients may access only their own appointments (fails closed if profile is missing).
 * - Doctors may access only appointments assigned to their own doctor profile (fails closed if profile is missing).
 * - Returns 403 Forbidden for any unauthorized access or missing profile.
 */
async function assertCanAccessAppointment(req, appointment) {
  if (['admin', 'receptionist'].includes(req.user.roleName)) {
    return;
  }
  if (req.user.roleName === 'patient') {
    const patient = await Patient.findOne({ where: { userId: req.user.userId } });
    if (!patient) {
      throw ApiError.forbidden('No patient profile is linked to this account');
    }
    if (patient.patientId !== appointment.patientId) {
      throw ApiError.forbidden('You do not have access to this appointment');
    }
    return;
  }
  if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    if (!doctor) {
      throw ApiError.forbidden('No doctor profile is linked to this account');
    }
    if (doctor.doctorId !== appointment.doctorId) {
      throw ApiError.forbidden('You do not have access to this appointment');
    }
    return;
  }
  throw ApiError.forbidden('Unauthorized role for appointment access');
}

const getAppointment = asyncHandler(async (req, res) => {
  const appointment = await Appointment.findByPk(req.params.id, { include: getAppointmentIncludes(req.user.roleName) });
  if (!appointment) throw ApiError.notFound('Appointment not found');
  await assertCanAccessAppointment(req, appointment);
  new ApiResponse(200, appointment).send(res);
});

const rescheduleAppointment = asyncHandler(async (req, res) => {
  const appointmentId = req.params.id;

  const start = parseAppointmentTimestamp(req.body.scheduledStart);
  if (start < new Date()) throw ApiError.badRequest('Cannot reschedule to a time in the past');

  const updatedAppointment = await executeWithRetry(async () => {
    return sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (t) => {
        // 1. Re-read and lock the appointment, then verify its current status and ownership rules
        const appointment = await Appointment.findByPk(appointmentId, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!appointment) throw ApiError.notFound('Appointment not found');

        if (TERMINAL_APPOINTMENT_STATUSES.includes(appointment.status)) {
          throw ApiError.badRequest(`Cannot reschedule an appointment that is already ${appointment.status}`);
        }

        if (req.user.roleName === 'patient') {
          const own = await Patient.findOne({ where: { userId: req.user.userId }, transaction: t });
          if (!own || own.patientId !== appointment.patientId) {
            throw ApiError.forbidden('You can only reschedule your own appointments');
          }
        }

        // Determine destination doctor (preserve restriction if changing doctors is requested)
        const requestedDoctorId = req.body.doctorId ? Number(req.body.doctorId) : appointment.doctorId;
        if (requestedDoctorId !== appointment.doctorId) {
          throw ApiError.badRequest('Changing doctors during rescheduling is not supported');
        }

        // 2. Lock required doctor row(s) in deterministic order
        const doctorIdsToLock = Array.from(new Set([appointment.doctorId, requestedDoctorId])).sort((a, b) => a - b);
        for (const docId of doctorIdsToLock) {
          const lockedDoc = await Doctor.findByPk(docId, { transaction: t, lock: t.LOCK.UPDATE });
          if (!lockedDoc) throw ApiError.notFound('Doctor not found');
          if (!lockedDoc.isAvailable) throw ApiError.badRequest('This doctor is not currently accepting appointments');
        }

        // 3. Re-read or revalidate appointment data that could have changed while acquiring doctor locks
        await appointment.reload({ transaction: t, lock: t.LOCK.UPDATE });
        if (TERMINAL_APPOINTMENT_STATUSES.includes(appointment.status)) {
          throw ApiError.badRequest(`Cannot reschedule an appointment that is already ${appointment.status}`);
        }

        const durationMs = appointment.scheduledEnd - appointment.scheduledStart;
        const end = new Date(start.getTime() + (req.body.durationMinutes ? req.body.durationMinutes * 60000 : durationMs));

        // 4. Check conflicts while excluding the appointment being rescheduled
        if (await hasConflict(appointment.doctorId, start, end, appointment.appointmentId, t)) {
          throw ApiError.conflict('This doctor already has an appointment in that time slot');
        }

        // 5. Update and commit atomically
        appointment.scheduledStart = start;
        appointment.scheduledEnd = end;
        appointment.status = 'scheduled';
        await appointment.save({ transaction: t });
        await appointmentReminderLifecycle.replacePendingSchedule(appointment, t);

        return appointment;
      }
    );
  });

  // Post-commit side effects: notifications and audit log
  try {
    const patient = await Patient.findByPk(updatedAppointment.patientId);
    await notificationService.notifyAppointmentRescheduled(updatedAppointment, patient.userId);
  } catch (notifyErr) {
    logger.warn(`Failed to send appointment rescheduled notification: ${notifyErr.message}`);
  }

  try {
    await auditLog.record({
      userId: req.user.userId,
      action: 'RESCHEDULE_APPOINTMENT',
      entityType: 'Appointment',
      entityId: updatedAppointment.appointmentId,
      ipAddress: req.ip,
    });
  } catch (auditErr) {
    logger.warn(`Failed to record audit log for appointment rescheduling: ${auditErr.message}`);
  }

  const full = await Appointment.findByPk(updatedAppointment.appointmentId, { include: getAppointmentIncludes(req.user.roleName) });
  new ApiResponse(200, full, 'Appointment rescheduled').send(res);
});

const cancelAppointment = asyncHandler(async (req, res) => {
  const appointment = await executeWithRetry(() => sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
    async (t) => {
      const lockedAppointment = await Appointment.findByPk(req.params.id, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!lockedAppointment) throw ApiError.notFound('Appointment not found');
      if (TERMINAL_APPOINTMENT_STATUSES.includes(lockedAppointment.status)) {
        throw ApiError.badRequest(`Cannot cancel an appointment that is already ${lockedAppointment.status}`);
      }

      if (req.user.roleName === 'patient') {
        const own = await Patient.findOne({ where: { userId: req.user.userId }, transaction: t });
        if (!own || own.patientId !== lockedAppointment.patientId) {
          throw ApiError.forbidden('You can only cancel your own appointments');
        }
      }
      if (req.user.roleName === 'doctor') {
        const own = await Doctor.findOne({ where: { userId: req.user.userId }, transaction: t });
        if (!own || own.doctorId !== lockedAppointment.doctorId) {
          throw ApiError.forbidden('You can only cancel your own appointments');
        }
      }

      lockedAppointment.status = 'cancelled';
      lockedAppointment.cancellationReason = req.body.reason || null;
      await lockedAppointment.save({ transaction: t });
      await appointmentReminderLifecycle.invalidatePending(lockedAppointment, 'cancelled', t);
      return lockedAppointment;
    }
  ));

  try {
    const [patient, doctor] = await Promise.all([Patient.findByPk(appointment.patientId), Doctor.findByPk(appointment.doctorId)]);
    const doctorUser = await User.findByPk(doctor.userId);
    await Promise.all([
      notificationService.notifyAppointmentCancelled(appointment, patient.userId, req.body.reason),
      notificationService.notifyAppointmentCancelled(appointment, doctorUser.userId, req.body.reason),
    ]);
  } catch (notifyErr) {
    logger.warn(`Failed to send appointment cancelled notification: ${notifyErr.message}`);
  }

  try {
    await auditLog.record({ userId: req.user.userId, action: 'CANCEL_APPOINTMENT', entityType: 'Appointment', entityId: appointment.appointmentId, ipAddress: req.ip });
  } catch (auditErr) {
    logger.warn(`Failed to record audit log for appointment cancellation: ${auditErr.message}`);
  }

  new ApiResponse(200, appointment, 'Appointment cancelled').send(res);
});

const updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['confirmed', 'completed', 'no_show'].includes(status)) {
    throw ApiError.badRequest('status must be one of: confirmed, completed, no_show');
  }

  const result = await executeWithRetry(() => sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
    async (t) => {
      const appointment = await Appointment.findByPk(req.params.id, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!appointment) throw ApiError.notFound('Appointment not found');
      await assertCanAccessAppointment(req, appointment);

      if (TERMINAL_APPOINTMENT_STATUSES.includes(appointment.status)) {
        throw ApiError.badRequest(`Cannot update status of an appointment that is already ${appointment.status}`);
      }
      if (appointment.status === status) return { appointment, changed: false };

      appointment.status = status;
      await appointment.save({ transaction: t });
      if (status === 'completed' || status === 'no_show') {
        await appointmentReminderLifecycle.invalidatePending(appointment, status, t);
      }
      return { appointment, changed: true };
    }
  ));
  const { appointment, changed } = result;

  if (changed) {
    try {
      await auditLog.record({ userId: req.user.userId, action: 'UPDATE_APPOINTMENT_STATUS', entityType: 'Appointment', entityId: appointment.appointmentId, ipAddress: req.ip, metadata: { status } });
    } catch (auditErr) {
      logger.warn(`Failed to record audit log for appointment status update: ${auditErr.message}`);
    }
  }

  new ApiResponse(200, appointment, 'Appointment status updated').send(res);
});

module.exports = {
  getAvailableSlots, createAppointment, listAppointments, getAppointment,
  rescheduleAppointment, cancelAppointment, updateStatus, assertCanAccessAppointment,
};
