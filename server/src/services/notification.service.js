const { Notification } = require('../models');

async function notify({ userId, type, title, message, relatedAppointmentId = null }) {
  return Notification.create({ userId, type, title, message, relatedAppointmentId });
}

async function notifyAppointmentBooked(appointment, recipientUserId) {
  return notify({
    userId: recipientUserId,
    type: 'appointment_booked',
    title: 'Appointment scheduled',
    message: `An appointment has been scheduled for ${new Date(appointment.scheduledStart).toLocaleString()}.`,
    relatedAppointmentId: appointment.appointmentId,
  });
}

async function notifyAppointmentCancelled(appointment, recipientUserId, reason) {
  return notify({
    userId: recipientUserId,
    type: 'appointment_cancelled',
    title: 'Appointment cancelled',
    message: reason
      ? `The appointment on ${new Date(appointment.scheduledStart).toLocaleString()} was cancelled: ${reason}`
      : `The appointment on ${new Date(appointment.scheduledStart).toLocaleString()} was cancelled.`,
    relatedAppointmentId: appointment.appointmentId,
  });
}

async function notifyAppointmentRescheduled(appointment, recipientUserId) {
  return notify({
    userId: recipientUserId,
    type: 'appointment_rescheduled',
    title: 'Appointment rescheduled',
    message: `The appointment has been moved to ${new Date(appointment.scheduledStart).toLocaleString()}.`,
    relatedAppointmentId: appointment.appointmentId,
  });
}

module.exports = {
  notify,
  notifyAppointmentBooked,
  notifyAppointmentCancelled,
  notifyAppointmentRescheduled,
};
