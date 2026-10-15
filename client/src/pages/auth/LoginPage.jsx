import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AuthLayout } from '../../components/layout/AuthLayout';
import { Button, Input } from '../../components/ui/index';
import { useAuth } from '../../hooks/useAuth';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [serverError, setServerError] = useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm();

  const onSubmit = async (values) => {
    setServerError('');
    try {
      await login(values.email, values.password);
      toast.success('Welcome back');
      navigate(location.state?.from?.pathname || '/dashboard', { replace: true });
    } catch (err) {
      setServerError(err.response?.data?.message || 'Unable to sign in. Check your details and try again.');
    }
  };

  return (
    <AuthLayout
      title="Sign in to Meridian"
      subtitle="Enter your credentials to access your dashboard."
      footer={
        <>
          New patient?{' '}
          <Link to="/register" className="font-medium text-teal-600 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          placeholder="you@hospital.com"
          error={errors.email?.message}
          {...register('email', { required: 'Email is required' })}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          error={errors.password?.message}
          {...register('password', { required: 'Password is required' })}
        />

        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-xs font-medium text-teal-600 hover:underline">
            Forgot password?
          </Link>
        </div>

        {serverError && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-600">{serverError}</p>}

        <Button type="submit" isLoading={isSubmitting} className="mt-1 w-full" size="lg">
          Sign in
        </Button>
      </form>

      <div className="mt-6 rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-xs text-slate-500">
        <p className="font-medium text-slate-600">Demo accounts (password: Passw0rd!)</p>
        <p className="mt-1">admin@hms.test · r.verma@hms.test · n.fernandes@hms.test · karan.shah@hms.test</p>
      </div>
    </AuthLayout>
  );
}
