import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui/Modal';
import { Button, Select } from '../../components/ui/index';
import { doctorApi } from '../../api/endpoints';
import { WEEKDAYS } from '../../utils/constants';

function buildInitialState(existingSchedules = []) {
  const safeSchedules = Array.isArray(existingSchedules) ? existingSchedules : [];
  return WEEKDAYS.map((day) => {
    const existing = safeSchedules.find((s) => s.dayOfWeek === day.value);
    return {
      dayOfWeek: day.value,
      enabled: Boolean(existing),
      startTime: existing?.startTime?.slice(0, 5) || '09:00',
      endTime: existing?.endTime?.slice(0, 5) || '17:00',
      slotMinutes: existing?.slotMinutes || 30,
    };
  });
}

export default function ScheduleEditorModal({ isOpen, onClose, doctorId, existingSchedules = [], onSuccess }) {
  const [rows, setRows] = useState(() => buildInitialState(existingSchedules));
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setRows(buildInitialState(existingSchedules));
    }
  }, [isOpen, existingSchedules]);

  const updateRow = (index, patch) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const schedules = rows
        .filter((r) => r.enabled)
        .map((r) => ({ dayOfWeek: r.dayOfWeek, startTime: `${r.startTime}:00`, endTime: `${r.endTime}:00`, slotMinutes: Number(r.slotMinutes) }));
      await doctorApi.setSchedule(doctorId, schedules);
      toast.success('Schedule updated');
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update schedule');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit weekly schedule"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} isLoading={isSubmitting}>Save schedule</Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {WEEKDAYS.map((day, index) => {
          const row = rows[index];
          return (
            <div key={day.value} className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 rounded-lg border border-slate-100 p-2.5">
              <label className="flex w-24 items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => updateRow(index, { enabled: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                {day.short}
              </label>
              <input
                type="time"
                disabled={!row.enabled}
                value={row.startTime}
                onChange={(e) => updateRow(index, { startTime: e.target.value })}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-300"
              />
              <span className="text-center text-xs text-slate-400">to</span>
              <input
                type="time"
                disabled={!row.enabled}
                value={row.endTime}
                onChange={(e) => updateRow(index, { endTime: e.target.value })}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-300"
              />
              <Select
                disabled={!row.enabled}
                value={row.slotMinutes}
                onChange={(e) => updateRow(index, { slotMinutes: e.target.value })}
                className="text-xs disabled:bg-slate-50 disabled:text-slate-300"
              >
                <option value={15}>15m</option>
                <option value={20}>20m</option>
                <option value={30}>30m</option>
                <option value={45}>45m</option>
                <option value={60}>60m</option>
              </Select>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
