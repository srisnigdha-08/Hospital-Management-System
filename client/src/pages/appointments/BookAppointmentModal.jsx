import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui/Modal';
import { Button, Select, Textarea, Input, Spinner } from '../../components/ui/index';
import { doctorApi, patientApi, appointmentApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { useDebounce } from '../../hooks/useDebounce';
import { ROLES } from '../../utils/constants';
import { formatTime } from '../../utils/formatters';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function BookAppointmentModal({ isOpen, onClose, onSuccess }) {
  const { user } = useAuth();
  const needsPatientSelect = [ROLES.ADMIN, ROLES.RECEPTIONIST].includes(user?.roleName);

  const [doctors, setDoctors] = useState([]);
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [reason, setReason] = useState('');
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [patientQuery, setPatientQuery] = useState('');
  const debouncedPatientQuery = useDebounce(patientQuery);
  const [patientOptions, setPatientOptions] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);

  useEffect(() => {
    if (isOpen) {
      doctorApi
        .list({ limit: 100 })
        .then((res) => setDoctors(res.data.data || []))
        .catch(() => setDoctors([]));
    }
  }, [isOpen]);

  useEffect(() => {
    if (!needsPatientSelect || debouncedPatientQuery.trim().length < 2) {
      setPatientOptions([]);
      return;
    }
    patientApi
      .list({ search: debouncedPatientQuery, limit: 5 })
      .then((res) => setPatientOptions(res.data.data || []))
      .catch(() => setPatientOptions([]));
  }, [debouncedPatientQuery, needsPatientSelect]);

  useEffect(() => {
    if (!doctorId || !date) {
      setSlots([]);
      return;
    }
    setLoadingSlots(true);
    setSelectedSlot(null);
    appointmentApi
      .availability(doctorId, date)
      .then((res) => setSlots(res.data.data?.slots || []))
      .catch(() => setSlots([]))
      .finally(() => setLoadingSlots(false));
  }, [doctorId, date]);

  const reset = () => {
    setDoctorId('');
    setDate(todayISO());
    setSlots([]);
    setSelectedSlot(null);
    setReason('');
    setSelectedPatient(null);
    setPatientQuery('');
  };

  const handleSubmit = async () => {
    if (!doctorId || !selectedSlot) {
      toast.error('Choose a doctor and time slot first');
      return;
    }
    if (needsPatientSelect && !selectedPatient) {
      toast.error('Select a patient first');
      return;
    }
    setSubmitting(true);
    try {
      const durationMinutes = Math.round((new Date(selectedSlot.end) - new Date(selectedSlot.start)) / 60000);
      await appointmentApi.create({
        ...(needsPatientSelect && { patientId: selectedPatient.patientId }),
        doctorId: Number(doctorId),
        scheduledStart: selectedSlot.start,
        durationMinutes,
        reason: reason || undefined,
      });
      toast.success('Appointment booked');
      reset();
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not book appointment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { reset(); onClose(); }}
      title="Book an appointment"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button onClick={handleSubmit} isLoading={submitting} disabled={!selectedSlot}>Confirm booking</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {needsPatientSelect && (
          <div className="relative">
            <Input
              label="Patient"
              placeholder="Search by name or email…"
              value={
                selectedPatient
                  ? `${selectedPatient.User?.firstName || ''} ${selectedPatient.User?.lastName || ''}`.trim()
                  : patientQuery
              }
              onChange={(e) => { setSelectedPatient(null); setPatientQuery(e.target.value); }}
            />
            {patientOptions.length > 0 && !selectedPatient && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-100 bg-surface shadow-popover">
                {patientOptions.map((p) => (
                  <button
                    key={p.patientId}
                    onClick={() => { setSelectedPatient(p); setPatientOptions([]); }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-teal-50/50"
                  >
                    {p.User ? `${p.User.firstName} ${p.User.lastName}` : 'Patient'}{' '}
                    <span className="data-mono">{p.registrationNumber}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Select label="Doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            <option value="">Select a doctor…</option>
            {doctors.map((d) => (
              <option key={d.doctorId} value={d.doctorId}>
                {d.User ? `Dr. ${d.User.firstName} ${d.User.lastName}` : 'Dr. Doctor'} — {d.specialization}
              </option>
            ))}
          </Select>
          <Input label="Date" type="date" min={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Available slots</p>
          {loadingSlots ? (
            <div className="flex justify-center py-6"><Spinner className="h-5 w-5 text-teal-600" /></div>
          ) : !doctorId ? (
            <p className="text-sm text-slate-400">Choose a doctor and date to see availability.</p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-slate-400">No open slots on this day. Try another date.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {slots.map((slot) => (
                <button
                  key={slot.start}
                  onClick={() => setSelectedSlot(slot)}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                    selectedSlot?.start === slot.start
                      ? 'border-teal-600 bg-teal-600 text-white'
                      : 'border-slate-200 text-slate-600 hover:border-teal-300 hover:bg-teal-50'
                  }`}
                >
                  {formatTime(slot.start)}
                </button>
              ))}
            </div>
          )}
        </div>

        <Textarea label="Reason for visit (optional)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}
