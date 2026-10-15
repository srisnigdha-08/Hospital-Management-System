import { NavLink } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../utils/constants';

const ICONS = {
  dashboard: (
    <path d="M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z" />
  ),
  patients: (
    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
  ),
  doctors: (
    <path d="M11 2v3.06A9.01 9.01 0 003.06 13H0v2h3.06A9.01 9.01 0 0011 22.94V22h2v.94A9.01 9.01 0 0020.94 15H24v-2h-3.06A9.01 9.01 0 0013 5.06V2h-2zm1 4a7 7 0 110 14 7 7 0 010-14zm-1 3v3H9v2h2v3h2v-3h2v-2h-2V9h-2z" />
  ),
  appointments: (
    <path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zm0 16H5V9h14v11zM7 11h5v5H7z" />
  ),
  records: (
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
  ),
  departments: (
    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
  ),
  users: (
    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
  ),
  profile: (
    <path d="M12 12c2.7 0 8 1.34 8 4v2H4v-2c0-2.66 5.3-4 8-4zm0-2a4 4 0 100-8 4 4 0 000 8z" />
  ),
};

function Icon({ name }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const NAV_BY_ROLE = {
  [ROLES.ADMIN]: [
    { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { to: '/patients', label: 'Patients', icon: 'patients' },
    { to: '/doctors', label: 'Doctors', icon: 'doctors' },
    { to: '/appointments', label: 'Appointments', icon: 'appointments' },
    { to: '/medical-records', label: 'Medical Records', icon: 'records' },
    { to: '/departments', label: 'Departments', icon: 'departments' },
    { to: '/users', label: 'Staff Accounts', icon: 'users' },
  ],
  [ROLES.RECEPTIONIST]: [
    { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { to: '/patients', label: 'Patients', icon: 'patients' },
    { to: '/doctors', label: 'Doctors', icon: 'doctors' },
    { to: '/departments', label: 'Departments', icon: 'departments' },
    { to: '/appointments', label: 'Appointments', icon: 'appointments' },
  ],
  [ROLES.DOCTOR]: [
    { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { to: '/appointments', label: 'My Appointments', icon: 'appointments' },
    { to: '/patients', label: 'Patients', icon: 'patients' },
    { to: '/departments', label: 'Departments', icon: 'departments' },
    { to: '/medical-records', label: 'Medical Records', icon: 'records' },
  ],
  [ROLES.PATIENT]: [
    { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { to: '/appointments', label: 'My Appointments', icon: 'appointments' },
    { to: '/medical-records', label: 'Medical History', icon: 'records' },
    { to: '/profile', label: 'My Profile', icon: 'profile' },
  ],
};

export function Sidebar({ isOpen, onClose }) {
  const { user } = useAuth();
  const items = NAV_BY_ROLE[user?.roleName] || [];

  return (
    <>
      {isOpen && <div className="fixed inset-0 z-30 bg-ink-950/50 lg:hidden" onClick={onClose} />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-ink-800 transition-transform lg:static lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2.5 px-6 py-6">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="11" stroke="#35BBAB" strokeWidth="1.5" />
            <path
              d="M4 12h3.5l1.5-4 2.5 8 2-6 1 2H20"
              stroke="#35BBAB"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span className="font-display text-lg font-bold tracking-tight text-white">Meridian</span>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors ${
                  isActive ? 'bg-teal-600/90 text-white' : 'text-ink-100/70 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <Icon name={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/10 px-6 py-4">
          <p className="text-[11px] uppercase tracking-wider text-ink-200/50">Meridian HMS · v1.0</p>
        </div>
      </aside>
    </>
  );
}
