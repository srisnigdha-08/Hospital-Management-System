import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { patientApi, medicalRecordApi } from '../../api/endpoints';
import { Card, PageHeader, Badge, Skeleton, EmptyState } from '../../components/ui/index';
import { formatDate, calculateAge, initials } from '../../utils/formatters';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../utils/constants';

const TABS = ['Overview', 'Emergency Contacts', 'Insurance', 'Medical History'];

export default function PatientProfilePage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [patient, setPatient] = useState(null);
  const [records, setRecords] = useState(null);
  const [activeTab, setActiveTab] = useState('Overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);

  const isSelf = !id && user?.roleName === ROLES.PATIENT;

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

  useEffect(() => {
    setLoading(true);
    setError(null);
    const request = id ? patientApi.get(id) : patientApi.me();
    request
      .then((res) => setPatient(res.data.data))
      .catch((err) => setError(err.response?.data?.message || 'Patient profile could not be loaded.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (activeTab === 'Medical History' && patient) {
      medicalRecordApi
        .list({ patientId: patient.patientId, limit: 20 })
        .then((res) => setRecords(res.data.data || []))
        .catch(() => setRecords([]));
    }
  }, [activeTab, patient]);

  if (loading && !patient) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (error || !patient) {
    return (
      <div>
        <PageHeader eyebrow="Patient Management" title="Patient Profile" />
        <EmptyState title="Unable to load patient" description={error || 'Patient not found.'} />
      </div>
    );
  }

  const patientName = `${patient.User?.firstName || ''} ${patient.User?.lastName || ''}`.trim() || 'Patient';

  return (
    <div>
      <PageHeader eyebrow="Patient Management" title={isSelf ? 'My Profile' : patientName} />

      <Card className="mb-6 flex flex-wrap items-center gap-6">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-teal-100 text-lg font-semibold text-teal-700">
          {initials(patient.User?.firstName, patient.User?.lastName)}
        </span>
        <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4">
          <Field label="Registration No." value={<span className="data-mono">{patient.registrationNumber}</span>} />
          <Field label="Age" value={calculateAge(patient.dateOfBirth)} />
          <Field label="Gender" value={<span className="capitalize">{patient.gender}</span>} />
          <Field label="Blood group" value={patient.bloodGroup} />
          <Field label="Email" value={patient.User?.email || '—'} />
          <Field label="Phone" value={patient.User?.phone || '—'} />
          <Field label="City" value={patient.city || '—'} />
          <Field
            label="Status"
            value={
              <Badge className={patient.User?.isActive ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-500'}>
                {patient.User?.isActive ? 'Active' : 'Inactive'}
              </Badge>
            }
          />
        </div>
      </Card>

      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === tab ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Overview' && (
        <Card>
          <h3 className="mb-3 font-display text-sm font-semibold text-ink-800">Address</h3>
          <p className="text-sm text-slate-600">
            {[patient.addressLine1, patient.addressLine2, patient.city, patient.state, patient.postalCode, patient.country]
              .filter(Boolean)
              .join(', ') || 'No address on file.'}
          </p>
        </Card>
      )}

      {activeTab === 'Emergency Contacts' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {patient.emergencyContacts?.length ? (
            patient.emergencyContacts.map((c) => (
              <Card key={c.contactId}>
                <p className="font-medium text-ink-800">{c.fullName} {c.isPrimary && <Badge className="ml-1 bg-teal-100 text-teal-700">Primary</Badge>}</p>
                <p className="mt-1 text-sm text-slate-500">{c.relationship}</p>
                <p className="mt-1 text-sm text-slate-600">{c.phone}</p>
              </Card>
            ))
          ) : (
            <EmptyState title="No emergency contacts on file" />
          )}
        </div>
      )}

      {activeTab === 'Insurance' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {patient.insurancePolicies?.length ? (
            patient.insurancePolicies.map((p) => (
              <Card key={p.insuranceId}>
                <p className="font-medium text-ink-800">{p.providerName}</p>
                <p className="data-mono mt-1">{p.policyNumber}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {formatDate(p.validFrom)} – {formatDate(p.validUntil)}
                </p>
              </Card>
            ))
          ) : (
            <EmptyState title="No insurance policies on file" />
          )}
        </div>
      )}

      {activeTab === 'Medical History' && (
        <div className="space-y-3">
          {!records ? (
            <Skeleton className="h-40 rounded-2xl" />
          ) : records.length === 0 ? (
            <EmptyState title="No medical records yet" />
          ) : (
            records.map((r) => (
              <Card key={r.recordId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-display text-sm font-semibold text-ink-800">{formatDate(r.visitDate)}</p>
                  <p className="text-xs text-slate-400">
                    Dr. {r.Doctor?.User ? `${r.Doctor.User.firstName} ${r.Doctor.User.lastName}` : 'Unassigned'}
                  </p>
                </div>
                <p className="mt-2 text-sm text-slate-700"><span className="font-medium">Diagnosis:</span> {r.diagnosis}</p>
                {r.symptoms && <p className="mt-1 text-sm text-slate-500"><span className="font-medium">Symptoms:</span> {r.symptoms}</p>}
                {r.treatmentNotes && <p className="mt-1 text-sm text-slate-500"><span className="font-medium">Notes:</span> {r.treatmentNotes}</p>}
                {r.Prescriptions?.length > 0 && (
                  <div className="mt-3 rounded-lg bg-slate-50 p-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Prescription</p>
                    {r.Prescriptions.flatMap((p) => p.items || []).filter(Boolean).map((item) => (
                      <p key={item.itemId || `${item.medicineName}-${Math.random()}`} className="text-sm text-slate-600">
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
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-ink-800">{value}</p>
    </div>
  );
}
