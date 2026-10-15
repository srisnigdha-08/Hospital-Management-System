import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AuthLayout } from '../../components/layout/AuthLayout';
import { Button, Input, Select } from '../../components/ui/index';
import { useAuth } from '../../hooks/useAuth';

export default function RegisterPage() {
  const { register: registerUser } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState('');
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm();

  const onSubmit = async (values) => {
    setServerError('');
    try {
      await registerUser(values);
      toast.success('Account created — welcome to Meridian');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setServerError(err.response?.data?.message || 'Registration failed. Please check your details.');
    }
  };

  return (
    <AuthLayout
      title="Create your patient account"
      subtitle="Book appointments and view your medical history online."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-teal-600 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Input label="First name" error={errors.firstName?.message} {...register('firstName', { required: 'Required' })} />
          <Input label="Last name" error={errors.lastName?.message} {...register('lastName', { required: 'Required' })} />
        </div>
        <Input label="Email address" type="email" error={errors.email?.message} {...register('email', { required: 'Email is required' })} />
        <Input label="Phone (optional)" type="tel" {...register('phone')} />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date of birth"
            type="date"
            error={errors.dateOfBirth?.message}
            {...register('dateOfBirth', { required: 'Required' })}
          />
          <Select label="Gender" error={errors.gender?.message} {...register('gender', { required: 'Required' })}>
            <option value="">Select…</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </Select>
        </div>
        <Input
          label="Password"
          type="password"
          hint="At least 8 characters, one uppercase letter, one number"
          error={errors.password?.message}
          {...register('password', {
            required: 'Password is required',
            minLength: { value: 8, message: 'At least 8 characters' },
            pattern: { value: /^(?=.*[A-Z])(?=.*\d).+$/, message: 'Add an uppercase letter and a number' },
          })}
        />
        <Input
          label="Confirm password"
          type="password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword', {
            required: 'Please confirm your password',
            validate: (v) => v === watch('password') || 'Passwords do not match',
          })}
        />

        {serverError && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-600">{serverError}</p>}

        <Button type="submit" isLoading={isSubmitting} className="mt-1 w-full" size="lg">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
