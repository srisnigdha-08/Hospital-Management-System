import { useMemo } from 'react';
import { Badge } from '../../components/ui/index';
import { APPOINTMENT_STATUS_STYLES } from '../../utils/constants';
import { formatDate, formatTime } from '../../utils/formatters';
import { getAppointmentCalendarDays, getLocalDateKey } from '../../utils/appointmentCalendar';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function userName(user) {
  if (!user) return '';
  return [user.firstName, user.lastName].filter(Boolean).join(' ');
}

function appointmentLabel(appointment, roleName) {
  const patient = userName(appointment.Patient?.User);
  const doctor = userName(appointment.Doctor?.User);
  if (roleName === 'patient') return doctor ? `Dr. ${doctor}` : 'Appointment';
  if (roleName === 'doctor') return patient || 'Appointment';
  if (patient && doctor) return `${patient} · Dr. ${doctor}`;
  return patient || (doctor ? `Dr. ${doctor}` : 'Appointment');
}

function AppointmentEntry({ appointment, roleName, compact = false }) {
  const status = APPOINTMENT_STATUS_STYLES[appointment.status];
  return (
    <article className="rounded-md border border-slate-200 bg-white p-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <time className="text-xs font-semibold tabular-nums text-ink-800" dateTime={appointment.scheduledStart}>
          {formatTime(appointment.scheduledStart)}
        </time>
        {status && <Badge className={status.className}>{status.label}</Badge>}
      </div>
      <p className={`mt-1 break-words text-slate-600 ${compact ? 'text-xs' : 'text-sm'}`}>
        {appointmentLabel(appointment, roleName)}
      </p>
    </article>
  );
}

function AppointmentList({ appointments, roleName, compact = false }) {
  return (
    <div className="flex flex-col gap-1.5">
      {appointments.map((appointment) => (
        <AppointmentEntry key={appointment.appointmentId} appointment={appointment} roleName={roleName} compact={compact} />
      ))}
    </div>
  );
}

export default function AppointmentCalendar({ view, selectedDate, appointments, roleName }) {
  const days = useMemo(() => getAppointmentCalendarDays(view, selectedDate), [view, selectedDate]);
  const grouped = useMemo(() => {
    const byDay = new Map(days.map((day) => [getLocalDateKey(day), []]));
    for (const appointment of appointments) {
      const key = getLocalDateKey(appointment.scheduledStart);
      if (byDay.has(key)) byDay.get(key).push(appointment);
    }
    for (const items of byDay.values()) {
      items.sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));
    }
    return byDay;
  }, [appointments, days]);

  if (view === 'day') {
    const items = grouped.get(selectedDate) || [];
    return (
      <section aria-label={`Appointments for ${formatDate(days[0], { weekday: 'long' })}`}>
        {appointments.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
            No appointments on this day.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((appointment) => <AppointmentEntry key={appointment.appointmentId} appointment={appointment} roleName={roleName} />)}
          </div>
        )}
      </section>
    );
  }

  const monthView = view === 'month';
  return (
    <section aria-label={monthView ? 'Appointments by month' : 'Appointments by week'}>
      {appointments.length === 0 && (
        <p className="mb-3 rounded-md border border-dashed border-slate-300 px-4 py-3 text-center text-sm text-slate-500">
          No appointments in this range.
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <div className={monthView ? 'min-w-[700px]' : 'min-w-[700px]'}>
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {WEEKDAYS.map((day) => (
              <div key={day} className="px-2 py-2 text-center text-xs font-semibold text-slate-600" aria-label={day}>
                <span className="hidden sm:inline">{day}</span>
                <span className="sm:hidden">{day.slice(0, 3)}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const key = getLocalDateKey(day);
              const items = grouped.get(key) || [];
              const inSelectedMonth = day.getFullYear() === Number(selectedDate.slice(0, 4))
                && day.getMonth() === Number(selectedDate.slice(5, 7)) - 1;
              return (
                <div
                  key={key}
                  className={`min-h-28 border-b border-r border-slate-200 p-1.5 ${monthView ? 'max-h-64 overflow-y-auto' : ''} ${inSelectedMonth ? 'bg-white' : 'bg-slate-50 text-slate-400'}`}
                >
                  <div className="mb-1 flex items-center justify-between gap-1">
                    <time dateTime={key} className={`text-xs font-semibold ${inSelectedMonth ? 'text-slate-700' : 'text-slate-400'}`}>
                      {day.toLocaleDateString(undefined, { day: 'numeric' })}
                    </time>
                    {items.length > 0 && <span className="text-[10px] text-slate-500">{items.length}</span>}
                  </div>
                  <AppointmentList appointments={items} roleName={roleName} compact />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
