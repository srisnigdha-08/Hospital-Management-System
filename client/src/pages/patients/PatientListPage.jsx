import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { patientApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { useDebounce } from '../../hooks/useDebounce';
import { PageHeader, Button, Input, Badge, EmptyState } from '../../components/ui/index';
import { Table } from '../../components/ui/Table';
import { Pagination } from '../../components/ui/Pagination';
import { formatDate, calculateAge, initials } from '../../utils/formatters';
import { ROLES } from '../../utils/constants';
import PatientFormModal from './PatientFormModal';

export default function PatientListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canManage = [ROLES.ADMIN, ROLES.RECEPTIONIST].includes(user?.roleName);
  const isDoctor = user?.roleName === ROLES.DOCTOR;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], meta: null });
  const [isLoading, setIsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = () => {
    setIsLoading(true);
    patientApi
      .list({ page, limit: 10, search: debouncedSearch || undefined })
      .then((res) => setData({ rows: res.data.data, meta: res.data.meta }))
      .catch(() => setData({ rows: [], meta: null }))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    load();
  }, [page, debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = [
    {
      key: 'name',
      header: 'Patient',
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-100 text-xs font-semibold text-teal-700">
            {initials(row.User?.firstName, row.User?.lastName)}
          </span>
          <div>
            <p className="font-medium text-ink-800">
              {row.User ? `${row.User.firstName} ${row.User.lastName}` : 'Unknown Patient'}
            </p>
            <p className="data-mono">{isDoctor ? `Patient ID ${row.patientId}` : row.registrationNumber}</p>
          </div>
        </div>
      ),
    },
    ...(!isDoctor ? [
      { key: 'email', header: 'Email', render: (row) => row.User?.email || '—' },
      { key: 'age', header: 'Age', render: (row) => calculateAge(row.dateOfBirth) },
      { key: 'gender', header: 'Gender', render: (row) => <span className="capitalize">{row.gender}</span> },
      { key: 'bloodGroup', header: 'Blood group', render: (row) => row.bloodGroup },
      {
        key: 'status',
        header: 'Status',
        render: (row) => (
          <Badge className={row.User?.isActive ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-500'}>
            {row.User?.isActive ? 'Active' : 'Inactive'}
          </Badge>
        ),
      },
    ] : []),
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Patient Management"
        title="Patients"
        description={isDoctor ? 'Search the patient directory.' : 'Search, review and manage patient records.'}
        actions={canManage && <Button onClick={() => setShowCreate(true)}>+ Register patient</Button>}
      />

      <div className="mb-4 max-w-sm">
        <Input placeholder={isDoctor ? 'Search by patient name…' : 'Search by name or email…'} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>

      <Table
        columns={columns}
        rows={data.rows}
        isLoading={isLoading}
        rowKey="patientId"
        onRowClick={!isDoctor ? (row) => navigate(`/patients/${row.patientId}`) : undefined}
        emptyState={
          <EmptyState
            title="No patients found"
            description={search ? 'Try a different search term.' : 'Register your first patient to get started.'}
          />
        }
      />

      {data.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPageChange={setPage} />}

      <PatientFormModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={() => {
          setShowCreate(false);
          load();
        }}
      />
    </div>
  );
}
