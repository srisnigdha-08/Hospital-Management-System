-- ====================================================================
-- Hospital Management System — Database Schema
-- Engine: MySQL 8.0+
-- Normal form: 3NF — every non-key attribute depends on the whole key
--              and nothing but the key.
-- ====================================================================

CREATE DATABASE IF NOT EXISTS hospital_management
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE hospital_management;

SET FOREIGN_KEY_CHECKS = 0;

-- --------------------------------------------------------------------
-- 1. ROLES  — lookup table for RBAC
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS roles;
CREATE TABLE roles (
  role_id     TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role_name   VARCHAR(30) NOT NULL UNIQUE,   -- admin | doctor | receptionist | patient
  description VARCHAR(255) NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 2. USERS — one row per login-capable identity (staff or patient)
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  user_id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role_id         TINYINT UNSIGNED NOT NULL,
  first_name      VARCHAR(60) NOT NULL,
  last_name       VARCHAR(60) NOT NULL,
  email           VARCHAR(120) NOT NULL UNIQUE,
  phone           VARCHAR(20) NULL,
  password_hash   VARCHAR(255) NOT NULL,
  token_version   INT UNSIGNED NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  avatar_url      VARCHAR(255) NULL,
  last_login_at   DATETIME NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  INDEX idx_users_role (role_id),
  INDEX idx_users_name (last_name, first_name)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 3. REFRESH TOKENS — supports rotating refresh-token auth
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS refresh_tokens;
CREATE TABLE refresh_tokens (
  token_id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id              BIGINT UNSIGNED NOT NULL,
  family_id            VARCHAR(64) NOT NULL,
  token_hash           VARCHAR(255) NOT NULL,
  expires_at           DATETIME NOT NULL,
  revoked_at           DATETIME NULL,
  created_by_ip        VARCHAR(45) NULL,
  replaced_by_token_id BIGINT UNSIGNED NULL,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  INDEX idx_rt_user (user_id),
  INDEX idx_rt_family (family_id),
  INDEX idx_rt_token_hash (token_hash),
  INDEX idx_rt_replaced_by (replaced_by_token_id),
  INDEX idx_rt_expires (expires_at)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 4. PASSWORD RESET TOKENS — forgot-password flow
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS password_reset_tokens;
CREATE TABLE password_reset_tokens (
  token_id    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  INDEX idx_prt_user (user_id)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 5. DEPARTMENTS
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS departments;
CREATE TABLE departments (
  department_id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(100) NOT NULL UNIQUE,
  description      VARCHAR(500) NULL,
  location         VARCHAR(120) NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 6. DOCTORS — 1:1 extension of users (role = doctor)
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS doctors;
CREATE TABLE doctors (
  doctor_id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT UNSIGNED NOT NULL UNIQUE,
  department_id    INT UNSIGNED NOT NULL,
  specialization   VARCHAR(120) NOT NULL,
  qualification    VARCHAR(255) NOT NULL,
  experience_years SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  license_number   VARCHAR(60) NOT NULL UNIQUE,
  consultation_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  bio              TEXT NULL,
  is_available     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_doctors_user FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_doctors_department FOREIGN KEY (department_id) REFERENCES departments(department_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  INDEX idx_doctors_department (department_id),
  INDEX idx_doctors_specialization (specialization)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 7. DOCTOR SCHEDULES — weekly recurring availability windows
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS doctor_schedules;
CREATE TABLE doctor_schedules (
  schedule_id   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doctor_id     BIGINT UNSIGNED NOT NULL,
  day_of_week   TINYINT UNSIGNED NOT NULL,      -- 0=Sunday .. 6=Saturday
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  slot_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_schedule_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT chk_schedule_time CHECK (end_time > start_time),
  CONSTRAINT chk_day_of_week CHECK (day_of_week BETWEEN 0 AND 6),
  UNIQUE KEY uq_doctor_day_start (doctor_id, day_of_week, start_time)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 8. PATIENTS — 1:1 extension of users (role = patient)
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS patients;
CREATE TABLE patients (
  patient_id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL UNIQUE,
  date_of_birth     DATE NOT NULL,
  gender            ENUM('male','female','other') NOT NULL,
  blood_group       ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown') NOT NULL DEFAULT 'unknown',
  address_line1     VARCHAR(150) NULL,
  address_line2     VARCHAR(150) NULL,
  city              VARCHAR(80) NULL,
  state             VARCHAR(80) NULL,
  postal_code       VARCHAR(20) NULL,
  country           VARCHAR(80) NULL,
  registration_number VARCHAR(30) NOT NULL UNIQUE,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_patients_user FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  INDEX idx_patients_dob (date_of_birth),
  INDEX idx_patients_regno (registration_number)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 9. PATIENT EMERGENCY CONTACTS (1 patient : many contacts)
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS patient_emergency_contacts;
CREATE TABLE patient_emergency_contacts (
  contact_id    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_id    BIGINT UNSIGNED NOT NULL,
  full_name     VARCHAR(120) NOT NULL,
  relationship  VARCHAR(60) NOT NULL,
  phone         VARCHAR(20) NOT NULL,
  email         VARCHAR(120) NULL,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_ec_patient FOREIGN KEY (patient_id) REFERENCES patients(patient_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  INDEX idx_ec_patient (patient_id)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 10. PATIENT INSURANCE (1 patient : many policies)
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS patient_insurance;
CREATE TABLE patient_insurance (
  insurance_id     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_id       BIGINT UNSIGNED NOT NULL,
  provider_name    VARCHAR(120) NOT NULL,
  policy_number    VARCHAR(80) NOT NULL,
  group_number     VARCHAR(80) NULL,
  valid_from       DATE NULL,
  valid_until      DATE NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_ins_patient FOREIGN KEY (patient_id) REFERENCES patients(patient_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE KEY uq_patient_policy (patient_id, policy_number),
  INDEX idx_ins_patient (patient_id)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 11. APPOINTMENTS
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS appointments;
CREATE TABLE appointments (
  appointment_id    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_id        BIGINT UNSIGNED NOT NULL,
  doctor_id         BIGINT UNSIGNED NOT NULL,
  department_id     INT UNSIGNED NOT NULL,
  scheduled_start    DATETIME NOT NULL,
  scheduled_end      DATETIME NOT NULL,
  status            ENUM('scheduled','confirmed','completed','cancelled','no_show') NOT NULL DEFAULT 'scheduled',
  reason            VARCHAR(255) NULL,
  cancellation_reason VARCHAR(255) NULL,
  booked_by_user_id BIGINT UNSIGNED NOT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES patients(patient_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_appt_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_appt_department FOREIGN KEY (department_id) REFERENCES departments(department_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_appt_booked_by FOREIGN KEY (booked_by_user_id) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_appt_time CHECK (scheduled_end > scheduled_start),
  INDEX idx_appt_doctor_time (doctor_id, scheduled_start),
  INDEX idx_appt_patient_time (patient_id, scheduled_start),
  INDEX idx_appt_status (status)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 12. APPOINTMENT REMINDERS — durable in-app reminder state (UTC instants)
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS appointment_reminders;
CREATE TABLE appointment_reminders (
  appointment_reminder_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_id BIGINT UNSIGNED NOT NULL,
  patient_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(96) NOT NULL,
  scheduled_start_utc DATETIME(3) NOT NULL,
  due_at_utc DATETIME(3) NOT NULL,
  next_attempt_at_utc DATETIME(3) NOT NULL,
  schedule_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  state ENUM('pending','delivered','cancelled','skipped','failed') NOT NULL DEFAULT 'pending',
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  claim_token VARCHAR(36) NULL,
  lease_expires_at_utc DATETIME(3) NULL,
  last_attempt_at_utc DATETIME(3) NULL,
  delivered_at_utc DATETIME(3) NULL,
  outcome_code VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_appointment_reminders_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_appointment_reminders_patient FOREIGN KEY (patient_id) REFERENCES patients(patient_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT chk_appointment_reminders_attempt_count CHECK (attempt_count <= 5),
  CONSTRAINT chk_appointment_reminders_claim_pair CHECK (
    (claim_token IS NULL AND lease_expires_at_utc IS NULL)
    OR (claim_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
  ),
  UNIQUE KEY uq_appointment_reminders_appointment (appointment_id),
  UNIQUE KEY uq_appointment_reminders_idempotency (idempotency_key),
  INDEX idx_appointment_reminders_due (state, next_attempt_at_utc, appointment_reminder_id),
  INDEX idx_appointment_reminders_lease (state, lease_expires_at_utc, appointment_reminder_id),
  INDEX idx_appointment_reminders_patient (patient_id)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 13. MEDICAL RECORDS — one per clinical encounter
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS medical_records;
CREATE TABLE medical_records (
  record_id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_id       BIGINT UNSIGNED NOT NULL,
  doctor_id        BIGINT UNSIGNED NOT NULL,
  appointment_id   BIGINT UNSIGNED NULL UNIQUE,
  visit_date       DATE NOT NULL,
  symptoms         TEXT NULL,
  diagnosis        TEXT NOT NULL,
  treatment_notes  TEXT NULL,
  follow_up_date   DATE NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mr_patient FOREIGN KEY (patient_id) REFERENCES patients(patient_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_mr_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_mr_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  INDEX idx_mr_patient (patient_id, visit_date),
  INDEX idx_mr_doctor (doctor_id, visit_date)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 14. PRESCRIPTIONS — header row per prescription issued in a record
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS prescriptions;
CREATE TABLE prescriptions (
  prescription_id  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  record_id        BIGINT UNSIGNED NOT NULL,
  issued_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes            VARCHAR(500) NULL,
  CONSTRAINT fk_presc_record FOREIGN KEY (record_id) REFERENCES medical_records(record_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  INDEX idx_presc_record (record_id)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 15. PRESCRIPTION ITEMS — line items (1 prescription : many drugs)
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS prescription_items;
CREATE TABLE prescription_items (
  item_id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  prescription_id  BIGINT UNSIGNED NOT NULL,
  medicine_name    VARCHAR(150) NOT NULL,
  dosage           VARCHAR(80) NOT NULL,
  frequency        VARCHAR(80) NOT NULL,
  duration         VARCHAR(80) NOT NULL,
  instructions     VARCHAR(255) NULL,
  CONSTRAINT fk_item_prescription FOREIGN KEY (prescription_id) REFERENCES prescriptions(prescription_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  INDEX idx_item_prescription (prescription_id)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 16. MEDICAL ATTACHMENTS — lab reports / scans / files per record
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS medical_attachments;
CREATE TABLE medical_attachments (
  attachment_id    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  record_id        BIGINT UNSIGNED NOT NULL,
  file_name        VARCHAR(255) NOT NULL,
  file_path        VARCHAR(500) NOT NULL,
  file_type        VARCHAR(50) NULL,
  file_size_bytes  INT UNSIGNED NULL,
  uploaded_by      BIGINT UNSIGNED NOT NULL,
  uploaded_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_att_record FOREIGN KEY (record_id) REFERENCES medical_records(record_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_att_uploader FOREIGN KEY (uploaded_by) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  INDEX idx_att_record (record_id)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 17. PAYMENTS — billing per appointment (optional module, included)
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS payments;
CREATE TABLE payments (
  payment_id       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_id   BIGINT UNSIGNED NOT NULL,
  amount           DECIMAL(10,2) NOT NULL,
  method           ENUM('cash','card','insurance','upi','bank_transfer') NOT NULL,
  status           ENUM('pending','paid','refunded','failed') NOT NULL DEFAULT 'pending',
  transaction_ref  VARCHAR(120) NULL,
  paid_at          DATETIME NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pay_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  INDEX idx_pay_appointment (appointment_id),
  INDEX idx_pay_status (status)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 18. NOTIFICATIONS — in-app notifications per user
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS notifications;
CREATE TABLE notifications (
  notification_id  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT UNSIGNED NOT NULL,
  type             ENUM('appointment_booked','appointment_cancelled','appointment_reminder',
                         'appointment_rescheduled','system') NOT NULL,
  title            VARCHAR(150) NOT NULL,
  message          VARCHAR(500) NOT NULL,
  related_appointment_id BIGINT UNSIGNED NULL,
  appointment_reminder_id BIGINT UNSIGNED NULL,
  reminder_scheduled_start_utc DATETIME(3) NULL,
  is_read          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_notif_appointment FOREIGN KEY (related_appointment_id) REFERENCES appointments(appointment_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_notifications_appointment_reminder FOREIGN KEY (appointment_reminder_id) REFERENCES appointment_reminders(appointment_reminder_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  UNIQUE KEY uq_notifications_appointment_reminder (appointment_reminder_id),
  INDEX idx_notif_user_read (user_id, is_read)
) ENGINE=InnoDB;

-- --------------------------------------------------------------------
-- 19. AUDIT LOGS — who did what, when
-- --------------------------------------------------------------------
DROP TABLE IF EXISTS audit_logs;
CREATE TABLE audit_logs (
  audit_id      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NULL,
  action        VARCHAR(80) NOT NULL,        -- e.g. CREATE_PATIENT, CANCEL_APPOINTMENT
  entity_type   VARCHAR(60) NOT NULL,        -- e.g. Patient, Appointment
  entity_id     BIGINT UNSIGNED NULL,
  ip_address    VARCHAR(45) NULL,
  metadata      JSON NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_user (user_id),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;

-- ====================================================================
-- Notes on normalization (3NF):
-- - users holds identity/auth data shared by every role.
-- - doctors/patients hold role-specific attributes only, linked 1:1 to
--   users, so a receptionist row never carries NULL medical columns.
-- - emergency contacts and insurance are separate 1:many tables rather
--   than repeating columns on patients (removes repeating groups /
--   satisfies 1NF, avoids partial dependency on patient_id).
-- - prescriptions/prescription_items are split header/line-item so a
--   record can carry multiple drugs without a multi-valued column.
-- - every non-key column depends only on its own table's primary key
--   (no column depends on part of a composite key or on another
--   non-key column), satisfying 2NF and 3NF.
-- ====================================================================
