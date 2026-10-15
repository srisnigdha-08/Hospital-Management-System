-- ====================================================================
-- Hospital Management System — Seed Data
-- Run AFTER schema.sql. All seed users share the password: Passw0rd!
-- (bcrypt hash below was generated with 12 salt rounds — see docs/DATABASE.md)
-- ====================================================================

USE hospital_management;

SET @PW := '$2b$12$WXzZtH90Sc70C1rpWwaJxO36PduWPYwWx.pj7onWP/orBahJUr68y';

-- Roles ----------------------------------------------------------------
INSERT INTO roles (role_name, description) VALUES
  ('admin', 'Full system access — manages users, departments and reports'),
  ('doctor', 'Clinical staff — manages own appointments and medical records'),
  ('receptionist', 'Front-desk staff — manages patients and appointment booking'),
  ('patient', 'End patient — views own appointments and medical history');

-- Departments ------------------------------------------------------------
INSERT INTO departments (name, description, location) VALUES
  ('Cardiology', 'Diagnosis and treatment of heart conditions', 'Block A, 2nd Floor'),
  ('Orthopedics', 'Bone, joint and muscle care', 'Block B, 1st Floor'),
  ('Pediatrics', 'Medical care for infants, children and adolescents', 'Block A, 1st Floor'),
  ('Dermatology', 'Skin, hair and nail conditions', 'Block C, 3rd Floor'),
  ('General Medicine', 'Primary and preventive care', 'Block A, Ground Floor');

-- Users --------------------------------------------------------------
INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, is_active) VALUES
  ((SELECT role_id FROM roles WHERE role_name='admin'),        'Ava',     'Menon',     'admin@hms.test',        '+91-9000000001', @PW, TRUE),
  ((SELECT role_id FROM roles WHERE role_name='doctor'),       'Rahul',   'Verma',     'r.verma@hms.test',      '+91-9000000002', @PW, TRUE),
  ((SELECT role_id FROM roles WHERE role_name='doctor'),       'Sara',    'Iyer',      's.iyer@hms.test',       '+91-9000000003', @PW, TRUE),
  ((SELECT role_id FROM roles WHERE role_name='receptionist'), 'Nina',    'Fernandes', 'n.fernandes@hms.test',  '+91-9000000004', @PW, TRUE),
  ((SELECT role_id FROM roles WHERE role_name='patient'),      'Karan',   'Shah',      'karan.shah@hms.test',   '+91-9000000005', @PW, TRUE),
  ((SELECT role_id FROM roles WHERE role_name='patient'),      'Priya',   'Nair',      'priya.nair@hms.test',   '+91-9000000006', @PW, TRUE);

-- Doctors --------------------------------------------------------------
INSERT INTO doctors (user_id, department_id, specialization, qualification, experience_years, license_number, consultation_fee, bio) VALUES
  ((SELECT user_id FROM users WHERE email='r.verma@hms.test'),
   (SELECT department_id FROM departments WHERE name='Cardiology'),
   'Interventional Cardiologist', 'MD, DM Cardiology', 12, 'LIC-CARD-1001', 900.00,
   'Specializes in coronary artery disease and preventive cardiology.'),
  ((SELECT user_id FROM users WHERE email='s.iyer@hms.test'),
   (SELECT department_id FROM departments WHERE name='Pediatrics'),
   'Pediatrician', 'MBBS, MD Pediatrics', 8, 'LIC-PED-2002', 600.00,
   'Focuses on child growth, vaccination and early diagnosis.');

-- Doctor weekly schedules (Mon–Fri, 09:00–13:00 and 14:00–17:00) --------
INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, slot_minutes)
SELECT d.doctor_id, dow.day, '09:00:00', '13:00:00', 30
FROM doctors d
JOIN (SELECT 1 AS day UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) dow;

INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, slot_minutes)
SELECT d.doctor_id, dow.day, '14:00:00', '17:00:00', 30
FROM doctors d
JOIN (SELECT 1 AS day UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) dow;

-- Patients ---------------------------------------------------------------
INSERT INTO patients (user_id, date_of_birth, gender, blood_group, address_line1, city, state, postal_code, country, registration_number) VALUES
  ((SELECT user_id FROM users WHERE email='karan.shah@hms.test'), '1990-04-12', 'male',   'B+', '221 MG Road', 'Bengaluru', 'Karnataka', '560001', 'India', 'REG-0001'),
  ((SELECT user_id FROM users WHERE email='priya.nair@hms.test'), '1985-11-02', 'female', 'O+', '18 Park Street', 'Kochi',    'Kerala',    '682001', 'India', 'REG-0002');

-- Emergency contacts -------------------------------------------------
INSERT INTO patient_emergency_contacts (patient_id, full_name, relationship, phone, is_primary)
SELECT patient_id, 'Meera Shah', 'Spouse', '+91-9000000010', TRUE FROM patients
  WHERE patient_id = (SELECT patient_id FROM patients p JOIN users u ON u.user_id=p.user_id WHERE u.email='karan.shah@hms.test');

INSERT INTO patient_emergency_contacts (patient_id, full_name, relationship, phone, is_primary)
SELECT patient_id, 'Anil Nair', 'Father', '+91-9000000011', TRUE FROM patients
  WHERE patient_id = (SELECT patient_id FROM patients p JOIN users u ON u.user_id=p.user_id WHERE u.email='priya.nair@hms.test');

-- Insurance ------------------------------------------------------------
INSERT INTO patient_insurance (patient_id, provider_name, policy_number, valid_from, valid_until)
SELECT patient_id, 'StarHealth', 'SH-88213', '2024-01-01', '2026-12-31' FROM patients
  WHERE patient_id = (SELECT patient_id FROM patients p JOIN users u ON u.user_id=p.user_id WHERE u.email='karan.shah@hms.test');

-- Sample appointment + medical record ---------------------------------
INSERT INTO appointments (patient_id, doctor_id, department_id, scheduled_start, scheduled_end, status, reason, booked_by_user_id)
SELECT
  (SELECT patient_id FROM patients p JOIN users u ON u.user_id=p.user_id WHERE u.email='karan.shah@hms.test'),
  (SELECT doctor_id FROM doctors d JOIN users u ON u.user_id=d.user_id WHERE u.email='r.verma@hms.test'),
  (SELECT department_id FROM departments WHERE name='Cardiology'),
  DATE_ADD(CURDATE(), INTERVAL 1 DAY) + INTERVAL 9 HOUR,
  DATE_ADD(CURDATE(), INTERVAL 1 DAY) + INTERVAL 9 HOUR + INTERVAL 30 MINUTE,
  'confirmed', 'Routine cardiac checkup',
  (SELECT user_id FROM users WHERE email='n.fernandes@hms.test');
