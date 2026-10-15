const { Op } = require('sequelize');
const { Appointment } = require('../models');
const ApiError = require('../utils/ApiError');

const CLINICAL_APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'completed'];

async function assertDoctorCanAccessPatient(doctorId, patientId, transaction = null) {
  const appointment = await Appointment.findOne({
    where: {
      doctorId,
      patientId,
      status: { [Op.in]: CLINICAL_APPOINTMENT_STATUSES },
    },
    ...(transaction && { transaction, lock: transaction.LOCK.UPDATE }),
  });

  if (!appointment) {
    throw ApiError.forbidden('You do not have an active care relationship with this patient');
  }
}

module.exports = { CLINICAL_APPOINTMENT_STATUSES, assertDoctorCanAccessPatient };
