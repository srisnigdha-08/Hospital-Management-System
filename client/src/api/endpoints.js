import client from './client';

export const authApi = {
  register: (payload) => client.post('/auth/register', payload),
  login: (payload) => client.post('/auth/login', payload),
  logout: (refreshToken) => client.post('/auth/logout', { refreshToken }),
  me: () => client.get('/auth/me'),
  forgotPassword: (email) => client.post('/auth/forgot-password', { email }),
  resetPassword: (payload) => client.post('/auth/reset-password', payload),
  changePassword: (payload) => client.post('/auth/change-password', payload),
};

export const userApi = {
  list: (params) => client.get('/users', { params }),
  create: (payload) => client.post('/users', payload),
  update: (id, payload) => client.patch(`/users/${id}`, payload),
  remove: (id) => client.delete(`/users/${id}`),
};

export const departmentApi = {
  list: (params) => client.get('/departments', { params }),
  get: (id) => client.get(`/departments/${id}`),
  create: (payload) => client.post('/departments', payload),
  update: (id, payload) => client.patch(`/departments/${id}`, payload),
  remove: (id) => client.delete(`/departments/${id}`),
};

export const doctorApi = {
  list: (params, config = {}) => client.get('/doctors', { ...config, params }),
  get: (id) => client.get(`/doctors/${id}`),
  create: (payload) => client.post('/doctors', payload),
  update: (id, payload) => client.patch(`/doctors/${id}`, payload),
  remove: (id) => client.delete(`/doctors/${id}`),
  setSchedule: (id, schedules) => client.put(`/doctors/${id}/schedule`, { schedules }),
};

export const patientApi = {
  list: (params) => client.get('/patients', { params }),
  get: (id) => client.get(`/patients/${id}`),
  me: () => client.get('/patients/me'),
  create: (payload) => client.post('/patients', payload),
  update: (id, payload) => client.patch(`/patients/${id}`, payload),
  remove: (id) => client.delete(`/patients/${id}`),
  addEmergencyContact: (id, payload) => client.post(`/patients/${id}/emergency-contacts`, payload),
  addInsurance: (id, payload) => client.post(`/patients/${id}/insurance`, payload),
};

export const appointmentApi = {
  list: (params, config = {}) => client.get('/appointments', { ...config, params }),
  get: (id) => client.get(`/appointments/${id}`),
  availability: (doctorId, date) => client.get('/appointments/availability', { params: { doctorId, date } }),
  create: (payload) => client.post('/appointments', payload),
  reschedule: (id, payload) => client.patch(`/appointments/${id}/reschedule`, payload),
  cancel: (id, reason) => client.patch(`/appointments/${id}/cancel`, { reason }),
  updateStatus: (id, status) => client.patch(`/appointments/${id}/status`, { status }),
};

export const medicalRecordApi = {
  list: (params) => client.get('/medical-records', { params }),
  get: (id) => client.get(`/medical-records/${id}`),
  create: (payload) => client.post('/medical-records', payload),
  update: (id, payload) => client.patch(`/medical-records/${id}`, payload),
  uploadAttachment: (id, formData) => client.post(`/medical-records/${id}/attachments`, formData),
  downloadAttachment: (id, attachmentId) =>
    client.get(`/medical-records/${id}/attachments/${attachmentId}`, {
      responseType: 'blob',
    }),
};

export const dashboardApi = {
  summary: () => client.get('/dashboard/summary'),
  appointmentsTrend: (days) => client.get('/dashboard/appointments-trend', { params: { days } }),
  departmentDistribution: () => client.get('/dashboard/department-distribution'),
  monthlyStats: (months) => client.get('/dashboard/monthly-stats', { params: { months } }),
};

export const notificationApi = {
  list: (params) => client.get('/notifications', { params }),
  markAsRead: (id) => client.patch(`/notifications/${id}/read`),
  markAllAsRead: () => client.patch('/notifications/read-all'),
};

export const searchApi = {
  global: (q) => client.get('/search', { params: { q } }),
};
