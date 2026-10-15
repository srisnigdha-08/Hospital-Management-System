import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { medicalRecordApi } from '../../api/endpoints';
import { useAuth } from '../../hooks/useAuth';
import { PageHeader, Button, Card, EmptyState, Skeleton } from '../../components/ui/index';
import { Pagination } from '../../components/ui/Pagination';
import { formatDate } from '../../utils/formatters';
import { ROLES } from '../../utils/constants';
import MedicalRecordFormModal from './MedicalRecordFormModal';

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt']);

function attachmentFileError(file) {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
    return 'Choose a PDF, PNG, JPEG, WEBP, or TXT file.';
  }
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return 'The file must be 10 MB or smaller.';
  }
  return '';
}

export default function MedicalRecordListPage() {
  const { user } = useAuth();
  const canCreate = [ROLES.ADMIN, ROLES.DOCTOR].includes(user?.roleName);

  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], meta: null });
  const [isLoading, setIsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState({});
  const [uploadErrors, setUploadErrors] = useState({});
  const [uploadingRecordIds, setUploadingRecordIds] = useState(new Set());
  const uploadingRecordsRef = useRef(new Set());

  const load = () => {
    setIsLoading(true);
    medicalRecordApi
      .list({ page, limit: 10 })
      .then((res) => setData({ rows: res.data.data, meta: res.data.meta }))
      .catch(() => setData({ rows: [], meta: null }))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    load();
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDownload = async (recordId, attachment) => {
    setDownloadingId(attachment.attachmentId);
    try {
      const res = await medicalRecordApi.downloadAttachment(recordId, attachment.attachmentId);
      const mime = res.headers['content-type'] || attachment.fileType || 'application/octet-stream';
      const blob = new Blob([res.data], { type: mime });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.fileName || 'medical-attachment';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to download attachment');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleFileChange = (recordId, event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const error = attachmentFileError(file);
    setUploadErrors((current) => ({ ...current, [recordId]: error }));
    setSelectedFiles((current) => {
      const next = { ...current };
      if (error) delete next[recordId];
      else next[recordId] = file;
      return next;
    });
    if (error) event.target.value = '';
  };

  const handleUpload = async (event, recordId) => {
    event.preventDefault();
    if (uploadingRecordsRef.current.has(recordId)) return;

    const file = selectedFiles[recordId];
    if (!file) {
      setUploadErrors((current) => ({ ...current, [recordId]: 'Choose a file to upload.' }));
      return;
    }

    const validationError = attachmentFileError(file);
    if (validationError) {
      setUploadErrors((current) => ({ ...current, [recordId]: validationError }));
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData();
    formData.append('file', file);
    uploadingRecordsRef.current.add(recordId);
    setUploadingRecordIds((current) => new Set(current).add(recordId));
    setUploadErrors((current) => ({ ...current, [recordId]: '' }));

    try {
      const response = await medicalRecordApi.uploadAttachment(recordId, formData);
      const attachment = response.data.data;
      setData((current) => ({
        ...current,
        rows: current.rows.map((record) => record.recordId === recordId
          ? {
            ...record,
            attachments: [...(record.attachments || []), attachment],
          }
          : record),
      }));
      setSelectedFiles((current) => {
        const next = { ...current };
        delete next[recordId];
        return next;
      });
      form.reset();
      toast.success('Attachment uploaded');
    } catch (err) {
      const message = err.response?.data?.message || 'Could not upload attachment. Please try again.';
      setUploadErrors((current) => ({ ...current, [recordId]: message }));
    } finally {
      uploadingRecordsRef.current.delete(recordId);
      setUploadingRecordIds((current) => {
        const next = new Set(current);
        next.delete(recordId);
        return next;
      });
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Medical Records"
        title={user?.roleName === ROLES.PATIENT ? 'My Medical History' : 'Medical Records'}
        description="Diagnoses, prescriptions and treatment notes."
        actions={canCreate && <Button onClick={() => setShowCreate(true)}>+ New record</Button>}
      />

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        </div>
      ) : data.rows.length === 0 ? (
        <EmptyState title="No medical records yet" />
      ) : (
        <div className="space-y-3">
          {data.rows.map((r) => {
            const prescriptionItems = r.Prescriptions?.flatMap((p) => p.items || []).filter(Boolean) || [];
            return (
              <Card key={r.recordId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-display text-sm font-semibold text-ink-800">{formatDate(r.visitDate)}</p>
                  <p className="text-xs text-slate-400">
                    {r.Patient?.User ? `${r.Patient.User.firstName} ${r.Patient.User.lastName}` : 'Patient'} · {r.Doctor?.User ? `Dr. ${r.Doctor.User.firstName} ${r.Doctor.User.lastName}` : 'Doctor'}
                  </p>
                </div>
                <p className="mt-2 text-sm text-slate-700"><span className="font-medium">Diagnosis:</span> {r.diagnosis}</p>
                {r.symptoms && <p className="mt-1 text-sm text-slate-500"><span className="font-medium">Symptoms:</span> {r.symptoms}</p>}
                {prescriptionItems.length > 0 && (
                  <div className="mt-3 rounded-lg bg-slate-50 p-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Prescription</p>
                    {prescriptionItems.map((item, idx) => (
                      <p key={item.itemId || idx} className="text-sm text-slate-600">
                        {item.medicineName} — {item.dosage}, {item.frequency}, {item.duration}
                      </p>
                    ))}
                  </div>
                )}
                {r.attachments?.length > 0 && (
                  <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Attachments</p>
                    <div className="flex flex-wrap gap-2">
                      {r.attachments.map((att) => (
                        <button
                          key={att.attachmentId}
                          type="button"
                          disabled={downloadingId === att.attachmentId}
                          onClick={() => handleDownload(r.recordId, att)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          <span>{att.fileName}</span>
                          {att.fileSizeBytes && (
                            <span className="text-[10px] text-slate-400">
                              ({(att.fileSizeBytes / 1024).toFixed(0)} KB)
                            </span>
                          )}
                          {downloadingId === att.attachmentId && (
                            <span className="text-[10px] font-semibold text-teal-600">Downloading…</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {canCreate && (
                  <form
                    className="mt-3 border-t border-slate-100 pt-3"
                    onSubmit={(event) => handleUpload(event, r.recordId)}
                    aria-busy={uploadingRecordIds.has(r.recordId)}
                  >
                    <label
                      htmlFor={`attachment-file-${r.recordId}`}
                      className="mb-1 block text-sm font-medium text-slate-700"
                    >
                      Add clinical attachment
                    </label>
                    <p id={`attachment-help-${r.recordId}`} className="mb-2 text-xs text-slate-500">
                      PDF, PNG, JPEG, WEBP, or TXT. Maximum 10 MB.
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <input
                        id={`attachment-file-${r.recordId}`}
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp,.txt"
                        aria-describedby={uploadErrors[r.recordId]
                          ? `attachment-help-${r.recordId} attachment-error-${r.recordId}`
                          : `attachment-help-${r.recordId}`}
                        aria-invalid={Boolean(uploadErrors[r.recordId])}
                        disabled={uploadingRecordIds.has(r.recordId)}
                        onChange={(event) => handleFileChange(r.recordId, event)}
                        className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-slate-700"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!selectedFiles[r.recordId]}
                        isLoading={uploadingRecordIds.has(r.recordId)}
                      >
                        {uploadingRecordIds.has(r.recordId) ? 'Uploading…' : 'Upload'}
                      </Button>
                    </div>
                    {uploadErrors[r.recordId] && (
                      <p id={`attachment-error-${r.recordId}`} role="alert" className="mt-1 text-xs text-danger-600">
                        {uploadErrors[r.recordId]}
                      </p>
                    )}
                  </form>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {data.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} total={data.meta.total} onPageChange={setPage} />}

      <MedicalRecordFormModal isOpen={showCreate} onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); load(); }} />
    </div>
  );
}
