# API Reference

Base URL: `http://localhost:5000/api` (dev). All responses use the envelope:

```json
{ "success": true, "message": "OK", "data": { }, "meta": { } }
```

`meta` is only present on paginated list endpoints:
`{ "page": 1, "limit": 10, "total": 42, "totalPages": 5 }`.

Errors follow the same shape with `"success": false` and an appropriate
HTTP status (400 validation, 401 unauthenticated, 403 forbidden, 404 not
found, 409 conflict, 500 server error). Validation errors additionally
include `"details": [{ "field": "...", "message": "..." }]`.

**Auth header** on every protected route: `Authorization: Bearer <accessToken>`.

## Auth — `/api/auth`

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/register` | Public | `firstName, lastName, email, phone?, password, dateOfBirth, gender, bloodGroup?` | Always creates a **patient** account. Returns `{ user, patientId, accessToken, refreshToken }`. |
| POST | `/login` | Public | `email, password` | Returns `{ user, accessToken, refreshToken }`. |
| POST | `/refresh` | Public | `refreshToken` | Rotates the refresh token (old one is revoked). Returns a new pair. |
| POST | `/logout` | Public | `refreshToken` | Revokes the given refresh token. |
| GET | `/me` | Required | — | Returns `{ user, profile }` (`profile` is the patient record, or `null` for staff). |
| POST | `/forgot-password` | Public | `email` | Always returns 200 regardless of whether the email exists. |
| POST | `/reset-password` | Public | `token, password` | `token` is the raw value emailed to the user. |
| POST | `/change-password` | Required | `currentPassword, newPassword` | Revokes all of the user's refresh tokens afterward. |

## Users (staff accounts) — `/api/users` — Admin only

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/` | — | Query: `page, limit, role, search`. |
| GET | `/:id` | — | |
| POST | `/` | `firstName, lastName, email, password, role` | `role` must be `admin` or `receptionist`. |
| PATCH | `/:id` | `firstName?, lastName?, phone?, isActive?` | |
| DELETE | `/:id` | — | Blocked (409) if the user has a linked doctor/patient profile. |

## Departments — `/api/departments`

| Method | Path | Auth | Body |
|---|---|---|---|
| GET | `/` | Any | Query: `all=true` for an unpaginated active list, or `page, limit, search`. |
| GET | `/:id` | Any | — |
| POST | `/` | Admin | `name, description?, location?` |
| PATCH | `/:id` | Admin | `name?, description?, location?, isActive?` |
| DELETE | `/:id` | Admin | Blocked (409) while doctors are assigned. |

## Doctors — `/api/doctors`

| Method | Path | Auth | Body |
|---|---|---|---|
| GET | `/` | Any | Query: `page, limit, department, search`. |
| GET | `/:id` | Any | — |
| POST | `/` | Admin | `firstName, lastName, email, phone?, password, departmentId, specialization, qualification, experienceYears?, licenseNumber, consultationFee?, bio?, schedules?[]`. Creates the login account and doctor profile together. |
| PATCH | `/:id` | Admin | `departmentId?, specialization?, qualification?, experienceYears?, consultationFee?, bio?, isAvailable?` |
| DELETE | `/:id` | Admin | Deactivates the account rather than hard-deleting. |
| PUT | `/:id/schedule` | Admin or the doctor themself | `schedules: [{ dayOfWeek, startTime, endTime, slotMinutes }]` — replaces the full weekly schedule. |

## Patients — `/api/patients`

| Method | Path | Auth | Body |
|---|---|---|---|
| GET | `/me` | Patient | Returns the caller's own patient profile. |
| GET | `/` | Admin, Receptionist, Doctor | Query: `page, limit, search, gender, bloodGroup` (gender/blood group filters apply to admins/receptionists only). Doctors receive only patient ID and name; doctor search matches names only. |
| GET | `/:id` | Admin, Receptionist; Patient (own); Doctor (patient with an established care relationship) | Returns the full patient profile, emergency contacts, and insurance. |
| POST | `/` | Admin, Receptionist | `firstName, lastName, email, password?, dateOfBirth, gender, bloodGroup?, addressLine1?, city?, …, emergencyContacts?[], insurancePolicies?[]` |
| PATCH | `/:id` | Admin, Receptionist; Patient (own); Doctor (patient with an established care relationship) | `gender?, bloodGroup?, addressLine1?, …, firstName?, lastName?, phone?` |
| DELETE | `/:id` | Admin, Receptionist | Deactivates the account. |
| POST | `/:id/emergency-contacts` | Admin, Receptionist; Patient (own); Doctor (patient with an established care relationship) | `fullName, relationship, phone, email?, isPrimary?` |
| POST | `/:id/insurance` | Admin, Receptionist; Patient (own); Doctor (patient with an established care relationship) | `providerName, policyNumber, groupNumber?, validFrom?, validUntil?` |

Patient and nested contact/insurance writes use explicit field allowlists. Unrecognized body fields are ignored for backward compatibility; patient and child identifiers and server-managed fields are derived by the server and are never mass-assigned from the request body.

## Appointments — `/api/appointments`

| Method | Path | Auth | Body |
|---|---|---|---|
| GET | `/availability` | Any | Query: `doctorId, date` (YYYY-MM-DD) → `{ slots: [{ start, end }] }` computed from the doctor's weekly schedule minus existing bookings. |
| GET | `/` | Any (scoped: patients/doctors see only their own) | Query: `page, limit, status, doctorId, patientId, from, to`. Doctor and patient responses embed patient ID and first/last name only. |
| GET | `/:id` | Any | Doctor and patient responses embed patient ID and first/last name only; ownership is checked before the response. Patients can retrieve their full profile from `/api/patients/me`. |
| POST | `/` | Admin, Receptionist, Patient | `patientId` (required for staff; ignored for patients — filled from the JWT), `doctorId, scheduledStart, durationMinutes?, reason?`. 409 on double-booking. |
| PATCH | `/:id/reschedule` | Admin, Receptionist, Patient (own) | `scheduledStart, durationMinutes?` |
| PATCH | `/:id/cancel` | Admin, Receptionist, Patient (own), Doctor (own) | `reason?` |
| PATCH | `/:id/status` | Admin, Receptionist; Doctor (own appointment) | `status: confirmed \| completed \| no_show` |

Availability dates and weekly schedule times are currently interpreted in the
backend Node process's local timezone; returned slot values are absolute ISO
timestamps. The deployment/runtime timezone therefore affects future slot
calculations. This is not a per-doctor timezone setting; changing the server
timezone should be treated as an operational scheduling change.

`scheduledStart` on booking and rescheduling must include an explicit `Z` or
numeric UTC offset. Offset-free date-times are rejected rather than interpreted
in the server's local timezone. Accepted instants are normalized to whole-second
precision because the appointment columns use MySQL `DATETIME` without a
fractional precision; the persisted value is the source for reminder scheduling.

Appointments in `cancelled`, `completed`, or `no_show` status are terminal:
cancel and reschedule requests are rejected, and terminal statuses cannot be
changed through the status endpoint. Cancellation and status changes serialize
against each other so concurrent requests cannot overwrite a committed terminal
state.

## Medical records — `/api/medical-records`

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| GET | `/` | Doctor, Admin, Patient | — | Scoped by role: patients view own; doctors view own or assigned patient (with verified care relationship); receptionists blocked (403). Query: `page, limit, patientId, doctorId`. |
| GET | `/:id` | Doctor, Admin, Patient | — | Patients limited to own record; doctors limited to treating records; receptionists blocked (403). |
| GET | `/:id/attachments/:attachmentId` | Doctor, Admin, Patient | — | Authenticated binary download with secure headers (`X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`). |
| POST | `/` | Doctor, Admin | `patientId, appointmentId?, visitDate, diagnosis, symptoms?, treatmentNotes?, followUpDate?, prescriptionItems?: [{ medicineName, dosage, frequency, duration, instructions? }]` | Doctors need an established care relationship. If supplied, the appointment must match the patient and doctor; scheduled/confirmed appointments become completed, completed appointments remain completed, and cancelled/no-show appointments are rejected. |
| PATCH | `/:id` | Attending Doctor, Admin | `diagnosis?, symptoms?, treatmentNotes?, followUpDate?` | Doctors may only update records where they are the attending physician. |
| POST | `/:id/attachments` | Attending Doctor, Admin | `multipart/form-data`, field name `file` | Max 10MB; pdf/png/jpeg/webp/txt only. Validated by file extension, MIME type, and magic bytes. Receptionists blocked (403). |


## Dashboard — `/api/dashboard`

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/summary` | Any | Role-shaped cards; global `recentActivities` audit rows are returned only to admins. Doctor appointment activity embeds patient ID and name only. |
| GET | `/appointments-trend` | Any | Query: `days` (default 14). `[{ day, count }]`, role-scoped. |
| GET | `/department-distribution` | Admin, Receptionist | `[{ department, count }]` |
| GET | `/monthly-stats` | Admin, Receptionist | Query: `months` (default 6). `[{ month, total, completed, cancelled }]` |

## Notifications — `/api/notifications`

| Method | Path | Body |
|---|---|---|
| GET | `/` | Query: `page, limit, unreadOnly`. |
| PATCH | `/:id/read` | — |
| PATCH | `/read-all` | — |

## Search — `/api/search` — Admin, Receptionist, Doctor

| Method | Path | Query |
|---|---|---|
| GET | `/` | `q` (min 2 chars) → `{ patients, doctors, appointments }`, 5 results each. Doctors receive patient IDs/names only and only their own appointments. |

## Health check

`GET /api/health` — no auth, returns `{ success, message, timestamp }`.
