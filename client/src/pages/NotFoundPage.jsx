import { Link } from 'react-router-dom';
import { VitalsDivider } from '../components/ui/VitalsDivider';

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-center">
      <p className="font-record text-6xl text-ink-800">404</p>
      <div className="my-4 w-40">
        <VitalsDivider tone="gold" />
      </div>
      <h1 className="font-display text-xl font-semibold text-ink-800">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-500">The page you're looking for doesn't exist or may have moved.</p>
      <Link to="/dashboard" className="mt-6 rounded-lg bg-ink-800 px-5 py-2.5 text-sm font-semibold text-white hover:bg-ink-700">
        Back to dashboard
      </Link>
    </div>
  );
}
