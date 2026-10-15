const { Op } = require('sequelize');
const { Patient, Doctor, Appointment, User, Department } = require('../models');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');

/** Staff-only global search across patients, doctors and appointments. */
const globalSearch = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) throw ApiError.badRequest('Search query must be at least 2 characters');

  const term = `%${q}%`;
  const isDoctor = req.user.roleName === 'doctor';

  const appointmentWhere = { reason: { [Op.like]: term } };
  if (req.user.roleName === 'doctor') {
    const doctor = await Doctor.findOne({ where: { userId: req.user.userId } });
    if (!doctor) {
      throw ApiError.forbidden('No doctor profile is linked to this account');
    }
    appointmentWhere.doctorId = doctor.doctorId;
  }

  const [patients, doctors, appointments] = await Promise.all([
    Patient.findAll({
      ...(isDoctor && { attributes: ['patientId'] }),
      include: [{
        model: User,
        attributes: isDoctor ? ['firstName', 'lastName'] : ['firstName', 'lastName', 'email'],
        where: {
          [Op.or]: [
            { firstName: { [Op.like]: term } },
            { lastName: { [Op.like]: term } },
            ...(!isDoctor ? [{ email: { [Op.like]: term } }] : []),
          ],
        },
      }],
      limit: 5,
    }),
    Doctor.findAll({
      include: [
        { model: User, attributes: ['firstName', 'lastName', 'email'], where: { [Op.or]: [{ firstName: { [Op.like]: term } }, { lastName: { [Op.like]: term } }] } },
        { model: Department, attributes: ['name'] },
      ],
      limit: 5,
    }),
    Appointment.findAll({
      where: appointmentWhere,
      include: [
        {
          model: Patient,
          ...(isDoctor && { attributes: ['patientId'] }),
          include: [{ model: User, attributes: ['firstName', 'lastName'] }],
        },
        { model: Doctor, include: [{ model: User, attributes: ['firstName', 'lastName'] }] },
      ],
      limit: 5,
    }),
  ]);

  new ApiResponse(200, { patients, doctors, appointments }).send(res);
});

module.exports = { globalSearch };
