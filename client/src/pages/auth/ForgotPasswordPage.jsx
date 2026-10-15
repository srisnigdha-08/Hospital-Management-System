import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { AuthLayout } from '../../components/layout/AuthLayout';
import { Button, Input } from '../../components/ui/index';
import { authApi } from '../../api/endpoints';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm();

  const onSubmit = async (values) => {
    try {
      await authApi.forgotPassword(values.email);
    } catch {
      // Don't leak whether email exists or not
    }
    setSent(true);
  };

  if (sent) {
    return (
      <AuthLayout title="Check your email" subtitle="If that address is registered, a reset link is on its way.">
        <p className="text-sm text-slate-500">
          The link expires in 30 minutes. Didn't get it?{' '}
          <button onClick={() => setSent(false)} className="font-medium text-teal-600 hover:underline">
            Try again
          </button>
        </p>
        <Link to="/login" className="mt-6 inline-block text-sm font-medium text-teal-600 hover:underline">
          ← Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email and we'll send you a reset link."
      footer={
        <Link to="/login" className="font-medium text-teal-600 hover:underline">
          ← Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <Input
          label="Email address"
          type="email"
          error={errors.email?.message}
          {...register('email', { required: 'Email is required' })}
        />
        <Button type="submit" isLoading={isSubmitting} className="w-full" size="lg">
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}
