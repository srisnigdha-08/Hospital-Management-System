# Meridian — Hospital Management System

A full-stack hospital management system: patient and doctor records, appointment
scheduling with real availability checking, medical records with prescriptions,
role-based dashboards, and an audited, JWT-secured REST API.

Built with **React + Tailwind** on the frontend, **Node.js/Express + Sequelize**
on the backend, and a **normalized MySQL** schema — designed to read like a real
clinical system, not a CRUD tutorial.

```
Frontend  → React 18, React Router, Tailwind CSS, React Hook Form, Chart.js, Axios
Backend   → Node.js, Express, Sequelize ORM, JWT auth, express-validator
Database  → MySQL 8 / MariaDB 10.6+ (3NF schema, 18 tables, full FK constraints)
```

## Contents

- [Features](#features)
- [Project structure](#project-structure)
- [Quick start](#quick-start)
- [Demo accounts](#demo-accounts)
- [Documentation](#documentation)
- [What's implemented vs. roadmap](#whats-implemented-vs-roadmap)

## Features

**Authentication & access control**
JWT access + rotating refresh tokens, bcrypt password hashing, forgot/reset
password flow, change password, and four roles (Admin, Doctor, Receptionist,
Patient) each with a distinct dashboard and route permissions enforced on
*every* API endpoint — not just hidden in the UI.

**Patient management**
Registration with emergency contacts and insurance policies, search and
filtering, profile view with tabbed medical history, soft deactivation.

**Doctor management**
Department assignment, specialization/qualification/experience, weekly
recurring availability schedules, per-doctor consultation fee.

**Appointments**
Real slot computation from a doctor's weekly schedule minus already-booked
appointments, conflict detection on booking/reschedule, cancellation with
reason, status lifecycle (scheduled → confirmed → completed / cancelled /
no-show), and role-scoped visibility (patients and doctors only ever see
their own appointments).

**Medical records**
Diagnosis, symptoms, treatment notes, follow-up dates, structured
prescriptions (multiple medicines per record), and file attachments for lab
reports/scans. Completing a record against an appointment automatically
marks that appointment completed.

**Dashboards**
Role-aware stat cards and charts (appointment volume trend, department
distribution, monthly completed/cancelled) backed by real SQL aggregation,
not mock numbers.

**Notifications & audit**
In-app notifications on booking/cancellation/reschedule, and a full audit
log (who did what, when) queried on the admin dashboard.

## Project structure

```
hospital-management-system/
├── client/            React frontend (Vite)
│   └── src/
│       ├── api/           Axios instance + endpoint definitions
│       ├── components/    layout, charts, reusable UI primitives
│       ├── context/       AuthContext (session state)
│       ├── pages/         one folder per module (patients, doctors, …)
│       └── routes/        protected / role-gated routing
├── server/            Express API
│   └── src/
│       ├── config/        env + Sequelize connection
│       ├── models/        Sequelize models + associations
│       ├── controllers/   business logic
│       ├── routes/        REST endpoints
│       ├── middleware/    auth, RBAC, rate limiting, uploads, error handling
│       ├── validators/    express-validator rule sets
│       └── services/      tokens, email (stub), notifications, audit log
├── database/
│   ├── schema.sql     full DDL — 18 tables, FKs, indexes, constraints
│   └── seed.sql       sample roles, departments, staff and patients
└── docs/              API, database, deployment and environment reference
```

## Quick start

Requirements: Node.js 18+, MySQL 8 or MariaDB 10.6+.

**1. Database**

```bash
mysql -u root -p < database/schema.sql
mysql -u root -p < database/seed.sql
```

**2. Backend**

```bash
cd server
cp .env.example .env    # then fill in DB_USER / DB_PASSWORD and JWT secrets
npm install
npm run dev              # http://localhost:5000
```

**3. Frontend**

```bash
cd client
cp .env.example .env     # defaults are fine for local dev (uses Vite's proxy)
npm install
npm run dev               # http://localhost:5173
```

Full step-by-step instructions, including production builds, are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Demo accounts

Seeded by `database/seed.sql`. Password for all of them: **`Passw0rd!`**

| Role         | Email                     |
|--------------|---------------------------|
| Admin        | admin@hms.test            |
| Doctor       | r.verma@hms.test          |
| Doctor       | s.iyer@hms.test           |
| Receptionist | n.fernandes@hms.test      |
| Patient      | karan.shah@hms.test       |
| Patient      | priya.nair@hms.test       |

## Documentation

- [`docs/DATABASE.md`](docs/DATABASE.md) — ER diagram, schema rationale, 3NF notes
- [`docs/API.md`](docs/API.md) — every endpoint, method, body and response shape
- [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) — every environment variable explained
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Vercel/Netlify + Render/Railway guide

## What's implemented vs. roadmap

This is a genuinely working system — every flow described above was tested
end-to-end against a real MySQL-compatible database while building it (auth,
booking, conflict detection, medical records, dashboards, RBAC). A few items
from a full enterprise wishlist are intentionally left as extension points
rather than faked:

| Item | Status |
|---|---|
| Email delivery | Stubbed in `services/email.service.js` — logs the message instead of sending. Swap in SendGrid/SES/SMTP; every caller already goes through this one function. |
| SMS notifications | Not implemented — in-app notifications cover the same events. |
| PDF prescription / report export | Not implemented — records are structured data, ready to feed a PDF renderer (e.g. `pdfkit`) if needed. |
| Excel export | Not implemented — list endpoints already support pagination/filtering that an export job could reuse. |
| Payments | Schema and model exist (`payments` table); no billing UI or payment gateway integration. |
| Dark mode | Not implemented. |

Everything else in the original module list — auth, RBAC, patient/doctor/
appointment/medical-record CRUD, dashboards, search, notifications, audit
logs — is fully implemented and wired end-to-end.
