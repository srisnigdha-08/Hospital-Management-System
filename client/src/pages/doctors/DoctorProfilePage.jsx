import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { doctorApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { Card, PageHeader, Badge, Skeleton, Button, EmptyState } from '../../components/ui/index';
import { formatCurrency, initials } from '../../utils/formatters';
import { WEEKDAYS, ROLES } from '../../utils/constants';
import ScheduleEditorModal from './ScheduleEditorModal';

export default function DoctorProfilePage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [doctor, setDoctor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showScheduleEditor, setShowScheduleEditor] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    doctorApi
      .get(id)
      .then((res) => setDoctor(res.data.data))
      .catch((err) => setError(err.response?.data?.message || 'Doctor profile could not be loaded.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canEditSchedule =
    user?.roleName === ROLES.ADMIN || (user?.roleName === ROLES.DOCTOR && doctor?.User?.userId === user.userId);

  if (loading && !doctor) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (error || !doctor) {
    return (
      <div>
        <PageHeader eyebrow="Doctor Management" title="Doctor Profile" />
        <EmptyState title="Doctor not found" description={error || 'Unable to locate doctor record.'} />
      </div>
    );
  }

  const doctorName = doctor.User ? `Dr. ${doctor.User.firstName} ${doctor.User.lastName}` : 'Doctor Profile';

  const schedulesByDay = WEEKDAYS.map((day) => ({
    ...day,
    slots: doctor.DoctorSchedules?.filter((s) => s.dayOfWeek === day.value) || [],
  }));

  return (
    <div>
      <PageHeader eyebrow="Doctor Management" title={doctorName} />

      <Card className="mb-6 flex flex-wrap items-center gap-6">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-ink-100 text-lg font-semibold text-ink-700">
          {initials(doctor.User?.firstName, doctor.User?.lastName)}
        </span>
        <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4">
          <Field label="Specialization" value={doctor.specialization} />
          <Field label="Department" value={doctor.Department?.name || '—'} />
          <Field label="Experience" value={`${doctor.experienceYears || 0} years`} />
          <Field label="License no." value={<span className="data-mono">{doctor.licenseNumber || '—'}</span>} />
          <Field label="Consultation fee" value={formatCurrency(doctor.consultationFee)} />
          <Field label="Email" value={doctor.User?.email || '—'} />
          <Field
            label="Status"
            value={
              <Badge className={doctor.isAvailable ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-500'}>
                {doctor.isAvailable ? 'Accepting patients' : 'Unavailable'}
              </Badge>
            }
          />
        </div>
      </Card>

      {doctor.bio && (
        <Card className="mb-6">
          <h3 className="mb-2 font-display text-sm font-semibold text-ink-800">About</h3>
          <p className="text-sm text-slate-600">{doctor.bio}</p>
        </Card>
      )}

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-ink-800">Weekly availability</h3>
          {canEditSchedule && (
            <Button size="sm" variant="outline" onClick={() => setShowScheduleEditor(true)}>
              Edit schedule
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-7">
          {schedulesByDay.map((day) => (
            <div key={day.value} className={`rounded-lg border p-3 text-center ${day.slots.length ? 'border-teal-200 bg-teal-50/40' : 'border-slate-100'}`}>
              <p className="text-xs font-semibold uppercase text-slate-500">{day.short}</p>
              {day.slots.length ? (
                day.slots.map((s) => (
                  <p key={s.scheduleId} className="mt-1 text-xs text-teal-700">{s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}</p>
                ))
              ) : (
                <p className="mt-1 text-xs text-slate-300">Off</p>
              )}
            </div>
          ))}
        </div>
      </Card>

      <ScheduleEditorModal
        isOpen={showScheduleEditor}
        onClose={() => setShowScheduleEditor(false)}
        doctorId={doctor.doctorId}
        existingSchedules={doctor.DoctorSchedules || []}
        onSuccess={() => { setShowScheduleEditor(false); load(); }}
      />
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-ink-800">{value}</p>
    </div>
  );
}
