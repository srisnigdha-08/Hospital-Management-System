import { Skeleton } from './index';

/**
 * columns: [{ key, header, render?(row), className? }]
 */
export function Table({ columns, rows, isLoading, emptyState, rowKey = 'id', onRowClick }) {
  if (isLoading) {
    return (
      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-surface">
        <div className="divide-y divide-slate-100">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-4 px-5 py-4">
              {columns.map((col) => (
                <Skeleton key={col.key} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return emptyState || null;
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-100 bg-surface shadow-card">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/60">
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-5 py-3 font-display text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr
              key={row[rowKey]}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? 'cursor-pointer hover:bg-teal-50/40' : ''}
            >
              {columns.map((col) => (
                <td key={col.key} className={`px-5 py-3.5 text-slate-700 ${col.className || ''}`}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
