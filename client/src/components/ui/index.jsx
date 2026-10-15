import { forwardRef } from 'react';

const BUTTON_VARIANTS = {
  primary: 'bg-ink-800 text-white hover:bg-ink-700 focus-visible:outline-ink-800',
  teal: 'bg-teal-600 text-white hover:bg-teal-700 focus-visible:outline-teal-600',
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  outline: 'border border-slate-300 text-slate-700 hover:bg-slate-50',
  danger: 'bg-danger-500 text-white hover:bg-danger-600',
  ghost: 'text-slate-600 hover:bg-slate-100',
};

export const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', className = '', isLoading = false, children, disabled, ...props },
  ref
) {
  const sizes = { sm: 'text-xs px-3 py-1.5 gap-1.5', md: 'text-sm px-4 py-2.5 gap-2', lg: 'text-base px-5 py-3 gap-2' };
  return (
    <button
      ref={ref}
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center rounded-lg font-display font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {isLoading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
});

export function Spinner({ className = 'h-5 w-5' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium font-display ${className}`}>
      {children}
    </span>
  );
}

export function Card({ children, className = '', padded = true }) {
  return (
    <div className={`rounded-2xl border border-slate-100 bg-surface shadow-card ${padded ? 'p-6' : ''} ${className}`}>
      {children}
    </div>
  );
}

export const Input = forwardRef(function Input({ label, error, hint, className = '', id, ...props }, ref) {
  const inputId = id || props.name;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={`rounded-lg border px-3.5 py-2.5 text-sm text-ink-800 placeholder:text-slate-400 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 ${
          error ? 'border-danger-500' : 'border-slate-300'
        } ${className}`}
        {...props}
      />
      {hint && !error && <span className="text-xs text-slate-400">{hint}</span>}
      {error && <span className="text-xs text-danger-500">{error}</span>}
    </div>
  );
});

export const Select = forwardRef(function Select({ label, error, className = '', id, children, ...props }, ref) {
  const selectId = id || props.name;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        className={`rounded-lg border px-3.5 py-2.5 text-sm text-ink-800 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 ${
          error ? 'border-danger-500' : 'border-slate-300'
        } ${className}`}
        {...props}
      >
        {children}
      </select>
      {error && <span className="text-xs text-danger-500">{error}</span>}
    </div>
  );
});

export const Textarea = forwardRef(function Textarea({ label, error, className = '', id, ...props }, ref) {
  const areaId = id || props.name;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={areaId} className="text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={areaId}
        className={`rounded-lg border px-3.5 py-2.5 text-sm text-ink-800 placeholder:text-slate-400 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 ${
          error ? 'border-danger-500' : 'border-slate-300'
        } ${className}`}
        {...props}
      />
      {error && <span className="text-xs text-danger-500">{error}</span>}
    </div>
  );
});

export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-md bg-slate-200/70 ${className}`} />;
}

export function EmptyState({ title, description, action, icon }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-200 px-6 py-14 text-center">
      {icon && <div className="text-slate-300">{icon}</div>}
      <h3 className="font-display text-base font-semibold text-ink-800">{title}</h3>
      {description && <p className="max-w-sm text-sm text-slate-500">{description}</p>}
      {action}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-teal-600">{eyebrow}</p>}
        <h1 className="font-display text-2xl font-bold text-ink-800">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
