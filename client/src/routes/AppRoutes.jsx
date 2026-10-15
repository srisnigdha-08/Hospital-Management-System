import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { RoleRoute } from './RoleRoute';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { ROLES } from '../utils/constants';

import LoginPage from '../pages/auth/LoginPage';
import RegisterPage from '../pages/auth/RegisterPage';
import ForgotPasswordPage from '../pages/auth/ForgotPasswordPage';
import ResetPasswordPage from '../pages/auth/ResetPasswordPage';

import DashboardPage from '../pages/dashboard/DashboardPage';
import PatientListPage from '../pages/patients/PatientListPage';
import PatientProfilePage from '../pages/patients/PatientProfilePage';
import DoctorListPage from '../pages/doctors/DoctorListPage';
import DoctorProfilePage from '../pages/doctors/DoctorProfilePage';
import AppointmentListPage from '../pages/appointments/AppointmentListPage';
import MedicalRecordListPage from '../pages/medical-records/MedicalRecordListPage';
import UserManagementPage from '../pages/admin/UserManagementPage';
import DepartmentManagementPage from '../pages/admin/DepartmentManagementPage';
import NotFoundPage from '../pages/NotFoundPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />

          <Route element={<RoleRoute allow={[ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR]} />}>
            <Route path="/patients" element={<PatientListPage />} />
            <Route path="/patients/:id" element={<PatientProfilePage />} />
          </Route>

          <Route element={<RoleRoute allow={[ROLES.PATIENT]} />}>
            <Route path="/profile" element={<PatientProfilePage />} />
          </Route>

          <Route path="/doctors" element={<DoctorListPage />} />
          <Route path="/doctors/:id" element={<DoctorProfilePage />} />

          <Route path="/appointments" element={<AppointmentListPage />} />

          <Route element={<RoleRoute allow={[ROLES.ADMIN, ROLES.DOCTOR, ROLES.PATIENT]} />}>
            <Route path="/medical-records" element={<MedicalRecordListPage />} />
          </Route>

          <Route element={<RoleRoute allow={[ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR]} />}>
            <Route path="/departments" element={<DepartmentManagementPage />} />
          </Route>

          <Route element={<RoleRoute allow={[ROLES.ADMIN]} />}>
            <Route path="/users" element={<UserManagementPage />} />
          </Route>

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
