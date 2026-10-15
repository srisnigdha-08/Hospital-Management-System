import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dashboardApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { Card, PageHeader, Skeleton, Badge } from '../../components/ui/index';
import { AppointmentsTrendChart, DepartmentDistributionChart, MonthlyStatsChart } from '../../components/charts/DashboardCharts';
import { formatDateTime } from '../../utils/formatters';
import { APPOINTMENT_STATUS_STYLES, ROLES } from '../../utils/constants';

function StatCard({ label, value, accent = 'ink' }) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`stat-figure text-3xl ${accent === 'teal' ? 'text-teal-600' : accent === 'gold' ? 'text-gold-600' : ''}`}>
        {value}
      </p>
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [trend, setTrend] = useState(null);
  const [departments, setDepartments] = useState(null);
  const [monthly, setMonthly] = useState(null);

  const isStaffAdmin = [ROLES.ADMIN, ROLES.RECEPTIONIST].includes(user?.roleName);

  useEffect(() => {
    dashboardApi
      .summary()
      .then((res) => setSummary(res.data.data))
      .catch(() => setSummary({ cards: {}, recentActivities: [] }));

    dashboardApi
      .appointmentsTrend(14)
      .then((res) => setTrend(res.data.data))
      .catch(() => setTrend([]));

    if (isStaffAdmin) {
      dashboardApi
        .departmentDistribution()
        .then((res) => setDepartments(res.data.data))
        .catch(() => setDepartments([]));

      dashboardApi
        .monthlyStats(6)
        .then((res) => setMonthly(res.data.data))
        .catch(() => setMonthly([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.roleName]);

  const greetingName = user?.firstName;

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title={`Good to see you, ${greetingName}`}
        description={
          isStaffAdmin
            ? "Here's how the hospital is running today."
            : user?.roleName === ROLES.DOCTOR
            ? "Here's your schedule and recent patient activity."
            : 'Your upcoming care and recent visits, at a glance.'
        }
      />

      {!summary ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : (
        <StatCards role={user?.roleName} cards={summary.cards} />
      )}

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h3 className="font-display text-sm font-semibold text-ink-800">Appointment volume — last 14 days</h3>
          {trend ? <div className="mt-4"><AppointmentsTrendChart data={trend} /></div> : <Skeleton className="mt-4 h-64" />}
        </Card>

        {isStaffAdmin ? (
          <Card>
            <h3 className="font-display text-sm font-semibold text-ink-800">Appointments by department</h3>
            {departments ? (
              <div className="mt-4">
                <DepartmentDistributionChart data={departments} />
              </div>
            ) : (
              <Skeleton className="mt-4 h-64" />
            )}
          </Card>
        ) : (
          <Card>
            <h3 className="font-display text-sm font-semibold text-ink-800">Recent activity</h3>
            <RecentActivityList role={user?.roleName} items={summary?.recentActivities} />
          </Card>
        )}
      </div>

      {isStaffAdmin && (
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <h3 className="font-display text-sm font-semibold text-ink-800">Monthly completed vs. cancelled</h3>
            {monthly ? <div className="mt-4"><MonthlyStatsChart data={monthly} /></div> : <Skeleton className="mt-4 h-64" />}
          </Card>
          <Card>
            <h3 className="font-display text-sm font-semibold text-ink-800">Recent activity</h3>
            <RecentActivityList role={user?.roleName} items={summary?.recentActivities} />
          </Card>
        </div>
      )}
    </div>
  );
}

function StatCards({ role, cards }) {
  if (role === ROLES.ADMIN || role === ROLES.RECEPTIONIST) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Total patients" value={cards.totalPatients} />
        <StatCard label="Total doctors" value={cards.totalDoctors} />
        <StatCard label="Today's appointments" value={cards.todaysAppointments} accent="teal" />
        <StatCard label="Upcoming" value={cards.upcomingAppointments} />
        <StatCard label="Cancelled today" value={cards.cancelledToday} accent="gold" />
      </div>
    );
  }
  if (role === ROLES.DOCTOR) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Today's appointments" value={cards.todaysAppointments} accent="teal" />
        <StatCard label="Upcoming" value={cards.upcomingAppointments} />
        <StatCard label="Patients seen" value={cards.totalPatientsSeen} />
        <StatCard label="Completed visits" value={cards.completedTotal} />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard label="Upcoming appointments" value={cards.upcomingAppointments} accent="teal" />
      <StatCard label="Past visits" value={cards.pastAppointments} />
      <Card className="flex flex-col justify-center gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Last visit</p>
        <p className="font-record text-lg text-ink-800">
          {cards.lastAppointment ? `Dr. ${cards.lastAppointment.Doctor?.User?.firstName} ${cards.lastAppointment.Doctor?.User?.lastName}` : 'No visits yet'}
        </p>
      </Card>
    </div>
  );
}

function RecentActivityList({ role, items }) {
  if (!items || items.length === 0) {
    return <p className="mt-4 text-sm text-slate-400">Nothing to show yet.</p>;
  }

  const isAdmin = role === ROLES.ADMIN || role === ROLES.RECEPTIONIST;

  return (
    <ul className="mt-4 space-y-3">
      {items.slice(0, 6).map((item) => (
        <li key={item.auditId || item.appointmentId} className="flex items-start justify-between gap-3 border-b border-slate-50 pb-3 last:border-0 last:pb-0">
          {isAdmin ? (
            <div>
              <p className="text-sm text-slate-700">
                <span className="font-medium">{(item.action || '').replace(/_/g, ' ').toLowerCase()}</span>
                {item.User && <span className="text-slate-400"> · {item.User.firstName} {item.User.lastName}</span>}
              </p>
              <p className="data-mono mt-0.5">{formatDateTime(item.created_at)}</p>
            </div>
          ) : (
            <div>
              <p className="text-sm font-medium text-slate-700">
                {item.Doctor?.User
                  ? `Dr. ${item.Doctor.User.firstName} ${item.Doctor.User.lastName}`
                  : item.Patient?.User
                  ? `${item.Patient.User.firstName} ${item.Patient.User.lastName}`
                  : 'Appointment'}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">{formatDateTime(item.scheduledStart)}</p>
            </div>
          )}
          {!isAdmin && item.status && (
            <Badge className={APPOINTMENT_STATUS_STYLES[item.status]?.className}>
              {APPOINTMENT_STATUS_STYLES[item.status]?.label}
            </Badge>
          )}
        </li>
      ))}
      <Link to="/appointments" className="block pt-1 text-xs font-medium text-teal-600 hover:underline">
        View all appointments →
      </Link>
    </ul>
  );
}
