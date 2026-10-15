export const ROLES = {
  ADMIN: 'admin',
  DOCTOR: 'doctor',
  RECEPTIONIST: 'receptionist',
  PATIENT: 'patient',
};

export const APPOINTMENT_STATUS_STYLES = {
  scheduled: { label: 'Scheduled', className: 'bg-slate-100 text-slate-700' },
  confirmed: { label: 'Confirmed', className: 'bg-teal-100 text-teal-700' },
  completed: { label: 'Completed', className: 'bg-success-50 text-success-600' },
  cancelled: { label: 'Cancelled', className: 'bg-danger-50 text-danger-600' },
  no_show: { label: 'No-show', className: 'bg-gold-100 text-gold-700' },
};

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'];

export const WEEKDAYS = [
  { value: 0, label: 'Sunday', short: 'Sun' },
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
];
