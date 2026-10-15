import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { appointmentApi, doctorApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { PageHeader, Button, Select, Badge, EmptyState } from '../../components/ui/index';
import { Table } from '../../components/ui/Table';
import { Pagination } from '../../components/ui/Pagination';
import { formatDateTime } from '../../utils/formatters';
import { APPOINTMENT_STATUS_STYLES, ROLES } from '../../utils/constants';
import {
  buildAppointmentCalendarQuery,
  canFilterAppointmentsByDoctor,
  fetchAllPages,
  formatLocalDateInput,
  getAppointmentCalendarRange,
  shiftAppointmentCalendarDate,
} from '../../utils/appointmentCalendar';
import AppointmentCalendar from './AppointmentCalendar';
import BookAppointmentModal from './BookAppointmentModal';
import CancelAppointmentModal from './CancelAppointmentModal';

const VIEW_OPTIONS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'table', label: 'Table' },
];

function calendarHeading(view, selectedDate) {
  const selected = new Date(`${selectedDate}T12:00:00`);
  const range = getAppointmentCalendarRange(view, selectedDate);
  const endDate = new Date(range.endExclusive);
  endDate.setDate(endDate.getDate() - 1);

  if (view === 'day') {
    return selected.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  if (view === 'week') {
    const startLabel = range.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const endLabel = endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `${startLabel} – ${endLabel}`;
  }
  return selected.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export default function AppointmentListPage() {
  const { user } = useAuth();
  const canBook = [ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.PATIENT].includes(user?.roleName);
  const canManageStatus = [ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR].includes(user?.roleName);
  const canFilterByDoctor = canFilterAppointmentsByDoctor(user?.roleName);

  const [view, setView] = useState('day');
  const [selectedDate, setSelectedDate] = useState(() => formatLocalDateInput(new Date()));
  const [status, setStatus] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [page, setPage] = useState(1);
  const [tableData, setTableData] = useState({ rows: [], meta: null });
  const [isTableLoading, setIsTableLoading] = useState(false);
  const [calendarData, setCalendarData] = useState({ rows: [], loading: true, error: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const [doctors, setDoctors] = useState([]);
  const [doctorsLoaded, setDoctorsLoaded] = useState(false);
  const [doctorsLoading, setDoctorsLoading] = useState(false);
  const [doctorsError, setDoctorsError] = useState(null);
  const [doctorRetry, setDoctorRetry] = useState(0);
  const [showBooking, setShowBooking] = useState(false);
  const [cancelTarget, setCancelTarget] = useState(null);

  const calendarQuery = useMemo(
    () => view === 'table' ? null : buildAppointmentCalendarQuery(view, selectedDate, { status, doctorId, roleName: user?.roleName }),
    [view, selectedDate, status, doctorId, user?.roleName]
  );
  const calendarRequestKey = JSON.stringify({ view, query: calendarQuery, refreshKey });

  useEffect(() => {
    if (view === 'table') return undefined;
    const controller = new AbortController();
    setCalendarData({ rows: [], loading: true, error: null, requestKey: calendarRequestKey });

    fetchAllPages(
      (params, config) => appointmentApi.list(params, config),
      calendarQuery,
      { signal: controller.signal }
    )
      .then((rows) => {
        if (!controller.signal.aborted) setCalendarData({ rows, loading: false, error: null, requestKey: calendarRequestKey });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setCalendarData({ rows: [], loading: false, error: error.response?.data?.message || error.message || 'Could not load appointments.', requestKey: calendarRequestKey });
        }
      });

    return () => controller.abort();
  }, [view, calendarQuery, calendarRequestKey]);

  useEffect(() => {
    if (view !== 'table') return undefined;
    const controller = new AbortController();
    setIsTableLoading(true);
    appointmentApi
      .list({ page, limit: 10, status: status || undefined }, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setTableData({ rows: res.data.data, meta: res.data.meta });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        toast.error(err.response?.data?.message || 'Could not load appointments');
        setTableData({ rows: [], meta: null });
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsTableLoading(false);
      });
    return () => controller.abort();
  }, [view, page, status, refreshKey]);

  useEffect(() => {
    if (!canFilterByDoctor || view === 'table' || doctorsLoaded) return undefined;
    const controller = new AbortController();
    setDoctorsLoading(true);
    setDoctorsError(null);
    fetchAllPages(
      (params, config) => doctorApi.list(params, config),
      {},
      { signal: controller.signal, getId: (doctor) => doctor?.doctorId, resourceLabel: 'doctor' }
    )
      .then((rows) => {
        if (!controller.signal.aborted) {
          setDoctors(rows);
          setDoctorsLoaded(true);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDoctorsError(error.message || 'Could not load doctors.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setDoctorsLoading(false);
      });
    return () => controller.abort();
  }, [canFilterByDoctor, view, doctorsLoaded, doctorRetry]);

  const refresh = () => setRefreshKey((current) => current + 1);
  const changeDate = (value) => {
    if (!value) return;
    setSelectedDate(value);
    setPage(1);
  };
  const movePeriod = (amount) => {
    setSelectedDate((current) => shiftAppointmentCalendarDate(current, view, amount));
    setPage(1);
  };

  const handleStatusChange = async (appointmentId, newStatus) => {
    try {
      await appointmentApi.updateStatus(appointmentId, newStatus);
      toast.success('Status updated');
      refresh();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update status');
    }
  };

  const columns = [
    {
      key: 'when',
      header: 'Date & time',
      render: (row) => <span className="font-medium text-ink-800">{formatDateTime(row.scheduledStart)}</span>,
    },
    {
      key: 'patient',
      header: 'Patient',
      render: (row) => (row.Patient?.User ? `${row.Patient.User.firstName} ${row.Patient.User.lastName}` : '—'),
    },
    {
      key: 'doctor',
      header: 'Doctor',
      render: (row) => (row.Doctor?.User ? `Dr. ${row.Doctor.User.firstName} ${row.Doctor.User.lastName}` : '—'),
    },
    { key: 'department', header: 'Department', render: (row) => row.Department?.name },
    { key: 'reason', header: 'Reason', render: (row) => row.reason || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge className={APPOINTMENT_STATUS_STYLES[row.status]?.className}>{APPOINTMENT_STATUS_STYLES[row.status]?.label}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          {canManageStatus && !['completed', 'cancelled'].includes(row.status) && (
            <select
              aria-label={`Change status for appointment at ${formatDateTime(row.scheduledStart)}`}
              defaultValue=""
              onChange={(event) => event.target.value && handleStatusChange(row.appointmentId, event.target.value)}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600"
            >
              <option value="">Mark as…</option>
              <option value="confirmed">Confirmed</option>
              <option value="completed">Completed</option>
              <option value="no_show">No-show</option>
            </select>
          )}
          {!['completed', 'cancelled'].includes(row.status) && (
            <button onClick={() => setCancelTarget(row)} className="text-xs font-medium text-danger-500 hover:underline">
              Cancel
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Appointment Management"
        title={user?.roleName === ROLES.PATIENT ? 'My Appointments' : user?.roleName === ROLES.DOCTOR ? 'My Appointments' : 'Appointments'}
        description="Book, track and manage appointments across the hospital."
        actions={canBook && <Button onClick={() => setShowBooking(true)}>+ Book appointment</Button>}
      />

      <div className="mb-4 flex flex-col gap-3 border-b border-slate-200 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-md border border-slate-200 bg-white p-1" role="group" aria-label="Appointment view">
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={view === option.value}
                onClick={() => setView(option.value)}
                className={`min-h-9 rounded px-3 text-sm font-medium ${view === option.value ? 'bg-teal-700 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Select id="appointment-status" label="Status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="confirmed">Confirmed</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="no_show">No-show</option>
            </Select>
            {canFilterByDoctor && view !== 'table' && (
              <Select
                id="appointment-doctor"
                label="Doctor"
                value={doctorId}
                disabled={doctorsLoading || Boolean(doctorsError)}
                onChange={(event) => { setDoctorId(event.target.value); setPage(1); }}
              >
                <option value="">All doctors</option>
                {doctors.map((doctor) => (
                  <option key={doctor.doctorId} value={doctor.doctorId}>
                    {doctor.User ? `Dr. ${doctor.User.firstName} ${doctor.User.lastName}` : `Doctor ${doctor.doctorId}`}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>

        {view !== 'table' && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Previous period"
                title="Previous period"
                onClick={() => movePeriod(-1)}
                className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 text-lg text-slate-700 hover:bg-slate-50"
              >
                ‹
              </button>
              <button type="button" onClick={() => changeDate(formatLocalDateInput(new Date()))} className="h-9 rounded-md border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
                Today
              </button>
              <button
                type="button"
                aria-label="Next period"
                title="Next period"
                onClick={() => movePeriod(1)}
                className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 text-lg text-slate-700 hover:bg-slate-50"
              >
                ›
              </button>
              <h2 className="ml-1 text-sm font-semibold text-ink-800 sm:text-base" aria-live="polite">
                {calendarHeading(view, selectedDate)}
              </h2>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <span>Go to date</span>
              <input
                type="date"
                aria-label="Go to date"
                value={selectedDate}
                onChange={(event) => changeDate(event.target.value)}
                className="h-9 rounded-md border border-slate-200 px-2 text-sm text-slate-700"
              />
            </label>
          </div>
        )}

        {doctorsError && canFilterByDoctor && view !== 'table' && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-danger-600" role="alert">
            <span>{doctorsError}</span>
            <button type="button" onClick={() => setDoctorRetry((current) => current + 1)} className="font-medium underline">
              Retry doctor list
            </button>
          </div>
        )}
      </div>

      {view === 'table' ? (
        <>
          <Table
            columns={columns}
            rows={tableData.rows}
            isLoading={isTableLoading}
            rowKey="appointmentId"
            emptyState={<EmptyState title="No appointments found" description="Book your first appointment to get started." />}
          />
          {tableData.meta && <Pagination page={tableData.meta.page} totalPages={tableData.meta.totalPages} total={tableData.meta.total} onPageChange={setPage} />}
        </>
      ) : calendarData.loading || calendarData.requestKey !== calendarRequestKey ? (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500" role="status">
          Loading appointments…
        </p>
      ) : calendarData.error ? (
        <div className="rounded-md border border-danger-200 bg-danger-50 px-4 py-6 text-center" role="alert">
          <p className="text-sm text-danger-700">{calendarData.error}</p>
          <Button variant="outline" className="mt-3" onClick={refresh}>Retry loading appointments</Button>
        </div>
      ) : (
        <AppointmentCalendar view={view} selectedDate={selectedDate} appointments={calendarData.rows} roleName={user?.roleName} />
      )}

      <BookAppointmentModal isOpen={showBooking} onClose={() => setShowBooking(false)} onSuccess={() => { setShowBooking(false); refresh(); }} />
      <CancelAppointmentModal appointment={cancelTarget} onClose={() => setCancelTarget(null)} onSuccess={() => { setCancelTarget(null); refresh(); }} />
    </div>
  );
}
