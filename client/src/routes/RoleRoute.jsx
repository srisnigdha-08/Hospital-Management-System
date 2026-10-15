import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function RoleRoute({ allow }) {
  const { user } = useAuth();

  if (!allow.includes(user?.roleName)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
