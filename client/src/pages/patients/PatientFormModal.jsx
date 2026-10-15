import { useForm, useFieldArray } from 'react-hook-form';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui/Modal';
import { Button, Input, Select } from '../../components/ui/index';
import { patientApi } from '../../api/endpoints';

const emptyContact = { fullName: '', relationship: '', phone: '', isPrimary: false };

export default function PatientFormModal({ isOpen, onClose, onSuccess }) {
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { emergencyContacts: [emptyContact] } });

  const { fields, append, remove } = useFieldArray({ control, name: 'emergencyContacts' });

  const onSubmit = async (values) => {
    try {
      await patientApi.create({
        ...values,
        emergencyContacts: values.emergencyContacts.filter((c) => c.fullName && c.phone),
      });
      toast.success('Patient registered');
      reset();
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not register patient');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Register a new patient" size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Input label="First name" error={errors.firstName?.message} {...register('firstName', { required: 'Required' })} />
          <Input label="Last name" error={errors.lastName?.message} {...register('lastName', { required: 'Required' })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Email" type="email" error={errors.email?.message} {...register('email', { required: 'Required' })} />
          <Input label="Phone" type="tel" {...register('phone')} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label="Date of birth" type="date" error={errors.dateOfBirth?.message} {...register('dateOfBirth', { required: 'Required' })} />
          <Select label="Gender" error={errors.gender?.message} {...register('gender', { required: 'Required' })}>
            <option value="">Select…</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </Select>
          <Select label="Blood group" {...register('bloodGroup')}>
            <option value="unknown">Unknown</option>
            {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </Select>
        </div>
        <Input label="Temporary password" type="text" hint="Shared with the patient to log in and change later" {...register('password', { required: 'Required', minLength: { value: 8, message: 'At least 8 characters' } })} error={errors.password?.message} />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-slate-700">Emergency contact</p>
            <button type="button" onClick={() => append(emptyContact)} className="text-xs font-medium text-teal-600 hover:underline">
              + Add another
            </button>
          </div>
          <div className="flex flex-col gap-3">
            {fields.map((field, index) => (
              <div key={field.id} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 rounded-lg border border-slate-100 p-3">
                <Input placeholder="Full name" {...register(`emergencyContacts.${index}.fullName`)} />
                <Input placeholder="Relationship" {...register(`emergencyContacts.${index}.relationship`)} />
                <Input placeholder="Phone" {...register(`emergencyContacts.${index}.phone`)} />
                {fields.length > 1 && (
                  <button type="button" onClick={() => remove(index)} className="text-slate-400 hover:text-danger-500">
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={isSubmitting}>Register patient</Button>
        </div>
      </form>
    </Modal>
  );
}
