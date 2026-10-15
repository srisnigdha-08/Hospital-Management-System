import { VitalsDivider } from '../ui/VitalsDivider';

export function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen bg-paper">
      <div className="relative hidden w-[42%] flex-col justify-between overflow-hidden bg-ink-800 px-12 py-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="11" stroke="#35BBAB" strokeWidth="1.5" />
            <path
              d="M4 12h3.5l1.5-4 2.5 8 2-6 1 2H20"
              stroke="#35BBAB"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span className="font-display text-xl font-bold tracking-tight">Meridian</span>
        </div>

        <div className="max-w-sm">
          <p className="font-record text-[2.75rem] italic leading-[1.15] text-white/95">
            Every patient, appointment and chart — read at a glance.
          </p>
          <div className="mt-8 text-ink-100">
            <VitalsDivider tone="teal" className="text-white" />
          </div>
          <p className="mt-4 text-sm text-ink-200/70">
            Meridian brings scheduling, records and staff coordination into one calm, dependable system of record.
          </p>
        </div>

        <p className="text-xs text-ink-200/40">© {new Date().getFullYear()} Meridian Health Systems</p>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="11" stroke="#0D9488" strokeWidth="1.5" />
              <path
                d="M4 12h3.5l1.5-4 2.5 8 2-6 1 2H20"
                stroke="#0D9488"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            <span className="font-display text-lg font-bold tracking-tight text-ink-800">Meridian</span>
          </div>

          <h1 className="font-display text-2xl font-bold text-ink-800">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-slate-500">{subtitle}</p>}

          <div className="mt-8">{children}</div>

          {footer && <div className="mt-6 text-center text-sm text-slate-500">{footer}</div>}
        </div>
      </div>
    </div>
  );
}
