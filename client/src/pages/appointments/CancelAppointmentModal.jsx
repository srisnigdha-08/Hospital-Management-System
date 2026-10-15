import { useState } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui/Modal';
import { Button, Textarea } from '../../components/ui/index';
import { appointmentApi } from '../../api/endpoints';
import { formatDateTime } from '../../utils/formatters';

export default function CancelAppointmentModal({ appointment, onClose, onSuccess }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await appointmentApi.cancel(appointment.appointmentId, reason || undefined);
      toast.success('Appointment cancelled');
      setReason('');
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not cancel appointment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={Boolean(appointment)}
      onClose={onClose}
      title="Cancel appointment"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Keep appointment</Button>
          <Button variant="danger" onClick={handleConfirm} isLoading={submitting}>Cancel appointment</Button>
        </>
      }
    >
      {appointment && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600">
            You're about to cancel the appointment on{' '}
            <span className="font-medium text-ink-800">{formatDateTime(appointment.scheduledStart)}</span>
            {appointment.Doctor?.User && (
              <>
                {' '}with{' '}
                <span className="font-medium text-ink-800">
                  Dr. {appointment.Doctor.User.firstName} {appointment.Doctor.User.lastName}
                </span>
              </>
            )}
            {appointment.Patient?.User && (
              <>
                {' '}for patient{' '}
                <span className="font-medium text-ink-800">
                  {appointment.Patient.User.firstName} {appointment.Patient.User.lastName}
                </span>
              </>
            )}
            . This cannot be undone.
          </p>
          <Textarea label="Reason (optional)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Let them know why…" />
        </div>
      )}
    </Modal>
  );
}
