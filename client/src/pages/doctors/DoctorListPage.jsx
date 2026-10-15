import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doctorApi, departmentApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { useDebounce } from '../../hooks/useDebounce';
import { PageHeader, Button, Input, Select, Badge, EmptyState } from '../../components/ui/index';
import { Table } from '../../components/ui/Table';
import { Pagination } from '../../components/ui/Pagination';
import { formatCurrency, initials } from '../../utils/formatters';
import { ROLES } from '../../utils/constants';
import DoctorFormModal from './DoctorFormModal';

export default function DoctorListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.roleName === ROLES.ADMIN;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [department, setDepartment] = useState('');
  const [page, setPage] = useState(1);
  const [departments, setDepartments] = useState([]);
  const [data, setData] = useState({ rows: [], meta: null });
  const [isLoading, setIsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    departmentApi
      .list({ all: true })
      .then((res) => setDepartments(res.data.data || []))
      .catch(() => setDepartments([]));
  }, []);

  const load = () => {
    setIsLoading(true);
    doctorApi
      .list({ page, limit: 10, search: debouncedSearch || undefined, department: department || undefined })
      .then((res) => setData({ rows: res.data.data, meta: res.data.meta }))
      .catch(() => setData({ rows: [], meta: null }))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    load();
  }, [page, debouncedSearch, department]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = [
    {
      key: 'name',
      header: 'Doctor',
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-700">
            {initials(row.User?.firstName, row.User?.lastName)}
          </span>
          <div>
            <p className="font-medium text-ink-800">
              {row.User ? `Dr. ${row.User.firstName} ${row.User.lastName}` : 'Dr. Unknown'}
            </p>
            <p className="text-xs text-slate-400">{row.specialization}</p>
          </div>
        </div>
      ),
    },
    { key: 'department', header: 'Department', render: (row) => row.Department?.name },
    { key: 'experience', header: 'Experience', render: (row) => `${row.experienceYears || 0} yrs` },
    { key: 'fee', header: 'Consultation fee', render: (row) => formatCurrency(row.consultationFee) },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge className={row.isAvailable ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-500'}>
          {row.isAvailable ? 'Accepting patients' : 'Unavailable'}
        </Badge>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Doctor Management"
        title="Doctors"
        description="Browse specialists, departments and availability."
        actions={isAdmin && <Button onClick={() => setShowCreate(true)}>+ Add doctor</Button>}
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <Input className="max-w-xs" placeholder="Search by name…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <Select className="max-w-xs" value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.departmentId} value={d.departmentId}>{d.name}</option>
          ))}
        </Select>
      </div>

      <Table
        columns={columns}
        rows={data.rows}
        isLoading={isLoading}
        rowKey="doctorId"
        onRowClick={(row) => navigate(`/doctors/${row.doctorId}`)}
        emptyState={<EmptyState title="No doctors found" description="Try adjusting your filters." />}
      />

      {data.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPageChange={setPage} />}

      <DoctorFormModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        departments={departments}
        onSuccess={() => { setShowCreate(false); load(); }}
      />
    </div>
  );
}
