const { sequelize } = require('../config/db');

const Role = require('./Role');
const User = require('./User');
const RefreshToken = require('./RefreshToken');
const PasswordResetToken = require('./PasswordResetToken');
const Department = require('./Department');
const Doctor = require('./Doctor');
const DoctorSchedule = require('./DoctorSchedule');
const Patient = require('./Patient');
const PatientEmergencyContact = require('./PatientEmergencyContact');
const PatientInsurance = require('./PatientInsurance');
const Appointment = require('./Appointment');
const AppointmentReminder = require('./AppointmentReminder');
const MedicalRecord = require('./MedicalRecord');
const Prescription = require('./Prescription');
const PrescriptionItem = require('./PrescriptionItem');
const MedicalAttachment = require('./MedicalAttachment');
const Payment = require('./Payment');
const Notification = require('./Notification');
const AuditLog = require('./AuditLog');

// ---- Role <-> User -------------------------------------------------
Role.hasMany(User, { foreignKey: 'roleId' });
User.belongsTo(Role, { foreignKey: 'roleId' });

// ---- User <-> RefreshToken / PasswordResetToken ---------------------
User.hasMany(RefreshToken, { foreignKey: 'userId', onDelete: 'CASCADE' });
RefreshToken.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(PasswordResetToken, { foreignKey: 'userId', onDelete: 'CASCADE' });
PasswordResetToken.belongsTo(User, { foreignKey: 'userId' });

// ---- User <-> Doctor (1:1) -------------------------------------------
User.hasOne(Doctor, { foreignKey: 'userId', onDelete: 'CASCADE' });
Doctor.belongsTo(User, { foreignKey: 'userId' });

// ---- Department <-> Doctor -------------------------------------------
Department.hasMany(Doctor, { foreignKey: 'departmentId' });
Doctor.belongsTo(Department, { foreignKey: 'departmentId' });

// ---- Doctor <-> DoctorSchedule ----------------------------------------
Doctor.hasMany(DoctorSchedule, { foreignKey: 'doctorId', onDelete: 'CASCADE' });
DoctorSchedule.belongsTo(Doctor, { foreignKey: 'doctorId' });

// ---- User <-> Patient (1:1) -------------------------------------------
User.hasOne(Patient, { foreignKey: 'userId', onDelete: 'CASCADE' });
Patient.belongsTo(User, { foreignKey: 'userId' });

// ---- Patient <-> EmergencyContact / Insurance --------------------------
Patient.hasMany(PatientEmergencyContact, { foreignKey: 'patientId', as: 'emergencyContacts', onDelete: 'CASCADE' });
PatientEmergencyContact.belongsTo(Patient, { foreignKey: 'patientId' });

Patient.hasMany(PatientInsurance, { foreignKey: 'patientId', as: 'insurancePolicies', onDelete: 'CASCADE' });
PatientInsurance.belongsTo(Patient, { foreignKey: 'patientId' });

// ---- Appointment relations --------------------------------------------
Patient.hasMany(Appointment, { foreignKey: 'patientId' });
Appointment.belongsTo(Patient, { foreignKey: 'patientId' });

Doctor.hasMany(Appointment, { foreignKey: 'doctorId' });
Appointment.belongsTo(Doctor, { foreignKey: 'doctorId' });

Department.hasMany(Appointment, { foreignKey: 'departmentId' });
Appointment.belongsTo(Department, { foreignKey: 'departmentId' });

Appointment.hasOne(AppointmentReminder, { foreignKey: 'appointmentId', onDelete: 'CASCADE' });
AppointmentReminder.belongsTo(Appointment, { foreignKey: 'appointmentId', onDelete: 'CASCADE' });
Patient.hasMany(AppointmentReminder, { foreignKey: 'patientId', onDelete: 'CASCADE' });
AppointmentReminder.belongsTo(Patient, { foreignKey: 'patientId', onDelete: 'CASCADE' });

User.hasMany(Appointment, { foreignKey: 'bookedByUserId' });
Appointment.belongsTo(User, { foreignKey: 'bookedByUserId', as: 'bookedBy' });

// ---- MedicalRecord relations -------------------------------------------
Patient.hasMany(MedicalRecord, { foreignKey: 'patientId' });
MedicalRecord.belongsTo(Patient, { foreignKey: 'patientId' });

Doctor.hasMany(MedicalRecord, { foreignKey: 'doctorId' });
MedicalRecord.belongsTo(Doctor, { foreignKey: 'doctorId' });

Appointment.hasOne(MedicalRecord, { foreignKey: 'appointmentId', onDelete: 'SET NULL' });
MedicalRecord.belongsTo(Appointment, { foreignKey: 'appointmentId' });

// ---- Prescription relations --------------------------------------------
MedicalRecord.hasMany(Prescription, { foreignKey: 'recordId', onDelete: 'CASCADE' });
Prescription.belongsTo(MedicalRecord, { foreignKey: 'recordId' });

Prescription.hasMany(PrescriptionItem, { foreignKey: 'prescriptionId', as: 'items', onDelete: 'CASCADE' });
PrescriptionItem.belongsTo(Prescription, { foreignKey: 'prescriptionId' });

// ---- Attachments ---------------------------------------------------
MedicalRecord.hasMany(MedicalAttachment, { foreignKey: 'recordId', as: 'attachments', onDelete: 'CASCADE' });
MedicalAttachment.belongsTo(MedicalRecord, { foreignKey: 'recordId' });

User.hasMany(MedicalAttachment, { foreignKey: 'uploadedBy' });
MedicalAttachment.belongsTo(User, { foreignKey: 'uploadedBy', as: 'uploader' });

// ---- Payments -------------------------------------------------------
Appointment.hasMany(Payment, { foreignKey: 'appointmentId', onDelete: 'CASCADE' });
Payment.belongsTo(Appointment, { foreignKey: 'appointmentId' });

// ---- Notifications ----------------------------------------------------
User.hasMany(Notification, { foreignKey: 'userId', onDelete: 'CASCADE' });
Notification.belongsTo(User, { foreignKey: 'userId' });

Appointment.hasMany(Notification, { foreignKey: 'relatedAppointmentId' });
Notification.belongsTo(Appointment, { foreignKey: 'relatedAppointmentId' });
AppointmentReminder.hasOne(Notification, { foreignKey: 'appointmentReminderId', onDelete: 'SET NULL' });
Notification.belongsTo(AppointmentReminder, { foreignKey: 'appointmentReminderId', onDelete: 'SET NULL' });

// ---- Audit logs -------------------------------------------------------
User.hasMany(AuditLog, { foreignKey: 'userId', onDelete: 'SET NULL' });
AuditLog.belongsTo(User, { foreignKey: 'userId' });

module.exports = {
  sequelize,
  Role,
  User,
  RefreshToken,
  PasswordResetToken,
  Department,
  Doctor,
  DoctorSchedule,
  Patient,
  PatientEmergencyContact,
  PatientInsurance,
  Appointment,
  AppointmentReminder,
  MedicalRecord,
  Prescription,
  PrescriptionItem,
  MedicalAttachment,
  Payment,
  Notification,
  AuditLog,
};
