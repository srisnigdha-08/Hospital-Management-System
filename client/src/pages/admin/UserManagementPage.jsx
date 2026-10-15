import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { userApi } from '../../api/endpoints';
import { PageHeader, Button, Badge, EmptyState, Select, Input } from '../../components/ui/index';
import { Table } from '../../components/ui/Table';
import { Pagination } from '../../components/ui/Pagination';
import { Modal } from '../../components/ui/Modal';
import { initials } from '../../utils/formatters';

export default function UserManagementPage() {
  const [page, setPage] = useState(1);
  const [role, setRole] = useState('');
  const [data, setData] = useState({ rows: [], meta: null });
  const [isLoading, setIsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = () => {
    setIsLoading(true);
    userApi
      .list({ page, limit: 10, role: role || undefined })
      .then((res) => setData({ rows: res.data.data, meta: res.data.meta }))
      .catch(() => setData({ rows: [], meta: null }))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    load();
  }, [page, role]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleActive = async (user) => {
    try {
      await userApi.update(user.userId, { isActive: !user.isActive });
      toast.success(user.isActive ? 'Account deactivated' : 'Account reactivated');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update account');
    }
  };

  const columns = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
            {initials(row.firstName, row.lastName)}
          </span>
          <p className="font-medium text-ink-800">{row.firstName} {row.lastName}</p>
        </div>
      ),
    },
    { key: 'email', header: 'Email' },
    { key: 'role', header: 'Role', render: (row) => <span className="capitalize">{row.roleName}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge className={row.isActive ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-500'}>
          {row.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button onClick={() => toggleActive(row)} className="text-xs font-medium text-teal-600 hover:underline">
          {row.isActive ? 'Deactivate' : 'Reactivate'}
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Admin Panel"
        title="Staff Accounts"
        description="Manage administrator and receptionist logins. Doctor accounts are managed from Doctors."
        actions={<Button onClick={() => setShowCreate(true)}>+ Add staff account</Button>}
      />

      <div className="mb-4 max-w-xs">
        <Select value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
          <option value="">All roles</option>
          <option value="admin">Admin</option>
          <option value="receptionist">Receptionist</option>
          <option value="doctor">Doctor</option>
          <option value="patient">Patient</option>
        </Select>
      </div>

      <Table columns={columns} rows={data.rows} isLoading={isLoading} rowKey="userId" emptyState={<EmptyState title="No accounts found" />} />

      {data.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPageChange={setPage} />}

      <CreateStaffModal isOpen={showCreate} onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); load(); }} />
    </div>
  );
}

function CreateStaffModal({ isOpen, onClose, onSuccess }) {
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm();

  const onSubmit = async (values) => {
    try {
      await userApi.create(values);
      toast.success('Staff account created');
      reset();
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not create account');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add staff account">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Input label="First name" error={errors.firstName?.message} {...register('firstName', { required: 'Required' })} />
          <Input label="Last name" error={errors.lastName?.message} {...register('lastName', { required: 'Required' })} />
        </div>
        <Input label="Email" type="email" error={errors.email?.message} {...register('email', { required: 'Required' })} />
        <Input label="Temporary password" error={errors.password?.message} {...register('password', { required: 'Required', minLength: { value: 8, message: 'At least 8 characters' } })} />
        <Select label="Role" error={errors.role?.message} {...register('role', { required: 'Required' })}>
          <option value="">Select…</option>
          <option value="admin">Admin</option>
          <option value="receptionist">Receptionist</option>
        </Select>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={isSubmitting}>Create account</Button>
        </div>
      </form>
    </Modal>
  );
}
