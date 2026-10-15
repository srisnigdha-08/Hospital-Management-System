import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { departmentApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../utils/constants';
import { PageHeader, Button, Card, Badge, EmptyState, Input, Textarea } from '../../components/ui/index';
import { Modal } from '../../components/ui/Modal';

export default function DepartmentManagementPage() {
  const { user } = useAuth();
  const isAdmin = user?.roleName === ROLES.ADMIN;
  const [departments, setDepartments] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = () => {
    departmentApi
      .list({ all: true })
      .then((res) => setDepartments(res.data.data || []))
      .catch(() => setDepartments([]));
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (dept) => {
    if (!window.confirm(`Delete the ${dept.name} department? This can't be undone.`)) return;
    try {
      await departmentApi.remove(dept.departmentId);
      toast.success('Department deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete department');
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Hospital Directory"
        title="Departments"
        description="Clinical departments, medical services and locations."
        actions={isAdmin && <Button onClick={() => setShowCreate(true)}>+ Add department</Button>}
      />

      {!departments ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : departments.length === 0 ? (
        <EmptyState title="No departments yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {departments.map((d) => (
            <Card key={d.departmentId}>
              <div className="flex items-start justify-between">
                <h3 className="font-display text-base font-semibold text-ink-800">{d.name}</h3>
                <Badge className={d.isActive ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-500'}>
                  {d.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              {d.location && <p className="mt-1 text-xs text-slate-400">{d.location}</p>}
              {d.description && <p className="mt-2 text-sm text-slate-600">{d.description}</p>}
              {isAdmin && (
                <div className="mt-4 flex gap-3 border-t border-slate-50 pt-3">
                  <button onClick={() => setEditing(d)} className="text-xs font-medium text-teal-600 hover:underline">Edit</button>
                  <button onClick={() => handleDelete(d)} className="text-xs font-medium text-danger-500 hover:underline">Delete</button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <DepartmentFormModal isOpen={showCreate} onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); load(); }} />
      <DepartmentFormModal
        isOpen={Boolean(editing)}
        department={editing}
        onClose={() => setEditing(null)}
        onSuccess={() => { setEditing(null); load(); }}
      />
    </div>
  );
}

function DepartmentFormModal({ isOpen, onClose, onSuccess, department }) {
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm({
    values: department || { name: '', description: '', location: '' },
  });

  const onSubmit = async (values) => {
    try {
      if (department) {
        await departmentApi.update(department.departmentId, values);
        toast.success('Department updated');
      } else {
        await departmentApi.create(values);
        toast.success('Department created');
      }
      reset();
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save department');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={department ? 'Edit department' : 'Add department'}>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <Input label="Name" error={errors.name?.message} {...register('name', { required: 'Required' })} />
        <Input label="Location" {...register('location')} />
        <Textarea label="Description" rows={3} {...register('description')} />
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={isSubmitting}>{department ? 'Save changes' : 'Create department'}</Button>
        </div>
      </form>
    </Modal>
  );
}
