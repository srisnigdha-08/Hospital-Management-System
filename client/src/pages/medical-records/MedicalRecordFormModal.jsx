import { useState, useEffect } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui/Modal';
import { Button, Input, Textarea, Select } from '../../components/ui/index';
import { medicalRecordApi, patientApi, doctorApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../utils/constants';

const emptyItem = { medicineName: '', dosage: '', frequency: '', duration: '', instructions: '' };

export default function MedicalRecordFormModal({ isOpen, onClose, onSuccess }) {
  const { user } = useAuth();
  const isDoctor = user?.roleName === ROLES.DOCTOR;
  const [doctors, setDoctors] = useState([]);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { visitDate: new Date().toISOString().slice(0, 10), prescriptionItems: [] } });

  const { fields, append, remove } = useFieldArray({ control, name: 'prescriptionItems' });

  const [patientQuery, setPatientQuery] = useState('');
  const [patientOptions, setPatientOptions] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);

  useEffect(() => {
    if (isOpen && !isDoctor) {
      doctorApi.list({ limit: 100 }).then((res) => setDoctors(res.data.data)).catch(() => setDoctors([]));
    }
  }, [isOpen, isDoctor]);

  const searchPatients = (value) => {
    setSelectedPatient(null);
    setPatientQuery(value);
    if (value.trim().length < 2) {
      setPatientOptions([]);
      return;
    }
    patientApi.list({ search: value, limit: 5 }).then((res) => setPatientOptions(res.data.data)).catch(() => setPatientOptions([]));
  };

  const onSubmit = async (values) => {
    if (!selectedPatient) {
      toast.error('Select a patient first');
      return;
    }
    if (!isDoctor && !values.doctorId) {
      toast.error('Select an attending doctor');
      return;
    }
    try {
      await medicalRecordApi.create({
        ...values,
        patientId: selectedPatient.patientId,
        doctorId: isDoctor ? undefined : Number(values.doctorId),
        prescriptionItems: values.prescriptionItems.filter((i) => i.medicineName),
      });
      toast.success('Medical record saved');
      reset();
      setSelectedPatient(null);
      setPatientQuery('');
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save record');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New medical record" size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {!isDoctor && (
          <Select label="Attending Doctor" error={errors.doctorId?.message} {...register('doctorId', { required: 'Doctor is required' })}>
            <option value="">Select doctor…</option>
            {doctors.map((d) => (
              <option key={d.doctorId} value={d.doctorId}>
                Dr. {d.User?.firstName} {d.User?.lastName} — {d.specialization}
              </option>
            ))}
          </Select>
        )}
        <div className="relative">
          <Input
            label="Patient"
            placeholder={isDoctor ? 'Search by patient name…' : 'Search by name or email…'}
            value={selectedPatient ? `${selectedPatient.User?.firstName || ''} ${selectedPatient.User?.lastName || ''}`.trim() : patientQuery}
            onChange={(e) => searchPatients(e.target.value)}
          />
          {patientOptions.length > 0 && !selectedPatient && (
            <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-100 bg-surface shadow-popover">
              {patientOptions.map((p) => (
                <button
                  key={p.patientId}
                  type="button"
                  onClick={() => { setSelectedPatient(p); setPatientOptions([]); }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-teal-50/50"
                >
                  {p.User?.firstName} {p.User?.lastName}{' '}
                  <span className="data-mono">{p.registrationNumber || `Patient ID ${p.patientId}`}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <Input label="Visit date" type="date" error={errors.visitDate?.message} {...register('visitDate', { required: 'Required' })} />
        <Textarea label="Symptoms" rows={2} {...register('symptoms')} />
        <Textarea label="Diagnosis" rows={2} error={errors.diagnosis?.message} {...register('diagnosis', { required: 'Required' })} />
        <Textarea label="Treatment notes" rows={2} {...register('treatmentNotes')} />
        <Input label="Follow-up date (optional)" type="date" {...register('followUpDate')} />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-slate-700">Prescription</p>
            <button type="button" onClick={() => append(emptyItem)} className="text-xs font-medium text-teal-600 hover:underline">
              + Add medicine
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {fields.map((field, index) => (
              <div key={field.id} className="grid grid-cols-5 gap-2 rounded-lg border border-slate-100 p-2.5">
                <Input placeholder="Medicine" {...register(`prescriptionItems.${index}.medicineName`)} />
                <Input placeholder="Dosage" {...register(`prescriptionItems.${index}.dosage`)} />
                <Input placeholder="Frequency" {...register(`prescriptionItems.${index}.frequency`)} />
                <Input placeholder="Duration" {...register(`prescriptionItems.${index}.duration`)} />
                <button type="button" onClick={() => remove(index)} className="text-slate-400 hover:text-danger-500">✕</button>
              </div>
            ))}
            {fields.length === 0 && <p className="text-xs text-slate-400">No medicines added.</p>}
          </div>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={isSubmitting}>Save record</Button>
        </div>
      </form>
    </Modal>
  );
}
