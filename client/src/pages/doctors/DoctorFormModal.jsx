import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui/Modal';
import { Button, Input, Select } from '../../components/ui/index';
import { doctorApi } from '../../api/endpoints';

export default function DoctorFormModal({ isOpen, onClose, onSuccess, departments = [] }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm();

  const onSubmit = async (values) => {
    try {
      await doctorApi.create({
        ...values,
        departmentId: Number(values.departmentId),
        experienceYears: Number(values.experienceYears || 0),
        consultationFee: Number(values.consultationFee || 0),
      });
      toast.success('Doctor added');
      reset();
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add doctor');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add a new doctor" size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Input label="First name" error={errors.firstName?.message} {...register('firstName', { required: 'Required' })} />
          <Input label="Last name" error={errors.lastName?.message} {...register('lastName', { required: 'Required' })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Email" type="email" error={errors.email?.message} {...register('email', { required: 'Required' })} />
          <Input label="Phone" type="tel" {...register('phone')} />
        </div>
        <Input label="Temporary password" hint="Shared with the doctor to log in and change later" error={errors.password?.message} {...register('password', { required: 'Required', minLength: { value: 8, message: 'At least 8 characters' } })} />

        <div className="grid grid-cols-2 gap-3">
          <Select label="Department" error={errors.departmentId?.message} {...register('departmentId', { required: 'Required' })}>
            <option value="">Select…</option>
            {(departments || []).map((d) => (
              <option key={d.departmentId} value={d.departmentId}>{d.name}</option>
            ))}
          </Select>
          <Input label="Specialization" error={errors.specialization?.message} {...register('specialization', { required: 'Required' })} />
        </div>
        <Input label="Qualification" error={errors.qualification?.message} {...register('qualification', { required: 'Required' })} />
        <div className="grid grid-cols-3 gap-3">
          <Input label="Experience (years)" type="number" min="0" {...register('experienceYears')} />
          <Input label="License number" error={errors.licenseNumber?.message} {...register('licenseNumber', { required: 'Required' })} />
          <Input label="Consultation fee (₹)" type="number" min="0" {...register('consultationFee')} />
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={isSubmitting}>Add doctor</Button>
        </div>
      </form>
    </Modal>
  );
}
