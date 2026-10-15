import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useDebounce } from '../../hooks/useDebounce';
import { notificationApi, searchApi } from '../../api/endpoints';
import { initials, formatDateTime } from '../../utils/formatters';
import { ROLES } from '../../utils/constants';

function useClickOutside(ref, onOutside) {
  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onOutside();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onOutside]);
}

export function Navbar({ onMenuClick }) {
  const { user, profile, logout } = useAuth();
  const navigate = useNavigate();
  const canSearch = [ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR].includes(user?.roleName);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 350);
  const [results, setResults] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  useClickOutside(searchRef, () => setSearchOpen(false));

  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);
  useClickOutside(notifRef, () => setNotifOpen(false));

  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef(null);
  useClickOutside(profileRef, () => setProfileOpen(false));

  useEffect(() => {
    if (debouncedQuery.trim().length < 2) {
      setResults(null);
      return;
    }
    searchApi
      .global(debouncedQuery)
      .then((res) => setResults(res.data.data))
      .catch(() => setResults(null));
  }, [debouncedQuery]);

  const loadNotifications = async () => {
    try {
      const res = await notificationApi.list({ limit: 8 });
      setNotifications(res.data.data);
      setUnreadCount(res.data.meta?.unreadCount || 0);
    } catch {
      // Non-critical — silently skip if unavailable.
    }
  };

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMarkAllRead = async () => {
    await notificationApi.markAllAsRead();
    loadNotifications();
  };

  const handleLogout = async () => {
    await logout();
    toast.success('Signed out');
    navigate('/login');
  };

  return (
    <header className="flex h-16 items-center gap-3 border-b border-slate-100 bg-surface px-4 sm:px-6">
      <button onClick={onMenuClick} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Open menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
        </svg>
      </button>

      {canSearch && (
        <div ref={searchRef} className="relative flex-1 max-w-md">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search patients, doctors, appointments…"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-1 focus:ring-teal-500"
          />
          {searchOpen && results && (
            <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-96 overflow-y-auto rounded-xl border border-slate-100 bg-surface shadow-popover">
              <SearchResults results={results} isDoctor={user?.roleName === ROLES.DOCTOR} onNavigate={() => setSearchOpen(false)} />
            </div>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <div ref={notifRef} className="relative">
          <button
            onClick={() => setNotifOpen((o) => !o)}
            className="relative rounded-full p-2 text-slate-500 hover:bg-slate-100"
            aria-label="Notifications"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13.73 21a2 2 0 01-3.46 0" strokeLinecap="round" />
            </svg>
            {unreadCount > 0 && (
              <span className="absolute right-1 top-1 flex h-2 w-2 rounded-full bg-gold-500" />
            )}
          </button>
          {notifOpen && (
            <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-xl border border-slate-100 bg-surface shadow-popover">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <p className="font-display text-sm font-semibold text-ink-800">Notifications</p>
                {unreadCount > 0 && (
                  <button onClick={handleMarkAllRead} className="text-xs font-medium text-teal-600 hover:underline">
                    Mark all read
                  </button>
                )}
              </div>
              <div className="max-h-80 overflow-y-auto">
                {notifications.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">You're all caught up.</p>}
                {notifications.map((n) => (
                  <div key={n.notificationId} className={`border-b border-slate-50 px-4 py-3 ${!n.isRead ? 'bg-teal-50/40' : ''}`}>
                    <p className="text-sm font-medium text-ink-800">{n.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{n.message}</p>
                    <p className="mt-1 data-mono text-[11px]">{formatDateTime(n.created_at)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div ref={profileRef} className="relative">
          <button onClick={() => setProfileOpen((o) => !o)} className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-slate-100">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-xs font-semibold text-white">
              {initials(user?.firstName, user?.lastName)}
            </span>
            <span className="hidden text-left sm:block">
              <span className="block text-sm font-medium text-ink-800">{user?.firstName} {user?.lastName}</span>
              <span className="block text-xs capitalize text-slate-400">{user?.roleName}</span>
            </span>
          </button>
          {profileOpen && (
            <div className="absolute right-0 top-full z-30 mt-2 w-48 rounded-xl border border-slate-100 bg-surface py-1.5 shadow-popover">
              {user?.roleName === ROLES.PATIENT && (
                <button
                  onClick={() => { setProfileOpen(false); navigate('/profile'); }}
                  className="block w-full px-4 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
                >
                  My profile
                </button>
              )}
              {user?.roleName === ROLES.DOCTOR && profile?.doctorId && (
                <button
                  onClick={() => { setProfileOpen(false); navigate(`/doctors/${profile.doctorId}`); }}
                  className="block w-full px-4 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
                >
                  My doctor profile
                </button>
              )}
              <button onClick={handleLogout} className="block w-full px-4 py-2 text-left text-sm text-danger-500 hover:bg-danger-50">
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function SearchResults({ results, isDoctor, onNavigate }) {
  const { patients, doctors, appointments } = results;
  const hasAny = patients.length || doctors.length || appointments.length;

  if (!hasAny) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400">No matches found.</p>;
  }

  return (
    <div className="py-2 text-sm">
      {patients.length > 0 && (
        <SearchGroup label="Patients">
          {patients.map((p) => (
            isDoctor ? (
              <p key={p.patientId} className="px-4 py-2 text-slate-700">
                {p.User ? `${p.User.firstName} ${p.User.lastName}` : 'Patient'}
                <span className="data-mono ml-2">Patient ID {p.patientId}</span>
              </p>
            ) : (
              <SearchLink key={p.patientId} to={`/patients/${p.patientId}`} onNavigate={onNavigate}>
                {p.User ? `${p.User.firstName} ${p.User.lastName}` : 'Patient'}{' '}
                <span className="data-mono">{p.registrationNumber}</span>
              </SearchLink>
            )
          ))}
        </SearchGroup>
      )}
      {doctors.length > 0 && (
        <SearchGroup label="Doctors">
          {doctors.map((d) => (
            <SearchLink key={d.doctorId} to={`/doctors/${d.doctorId}`} onNavigate={onNavigate}>
              Dr. {d.User ? `${d.User.firstName} ${d.User.lastName}` : 'Doctor'}{' '}
              <span className="text-slate-400">· {d.Department?.name}</span>
            </SearchLink>
          ))}
        </SearchGroup>
      )}
      {appointments.length > 0 && (
        <SearchGroup label="Appointments">
          {appointments.map((a) => (
            <SearchLink key={a.appointmentId} to="/appointments" onNavigate={onNavigate}>
              {a.reason || 'Appointment'}{' '}
              <span className="text-slate-400">
                · {a.Patient?.User ? `${a.Patient.User.firstName} ${a.Patient.User.lastName}` : 'Patient'}
              </span>
            </SearchLink>
          ))}
        </SearchGroup>
      )}
    </div>
  );
}

function SearchGroup({ label, children }) {
  return (
    <div className="mb-1">
      <p className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      {children}
    </div>
  );
}

function SearchLink({ to, children, onNavigate }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => {
        onNavigate();
        navigate(to);
      }}
      className="block w-full px-4 py-2 text-left text-slate-700 hover:bg-teal-50/50"
    >
      {children}
    </button>
  );
}
