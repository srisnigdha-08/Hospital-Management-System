-- Synthetic, deterministic Meridian integration-test fixtures.
-- Apply only once the reviewed test schema is installed in the dedicated test
-- database. Repeating this file is safe for its fixed fixture IDs: duplicate
-- keys restore these test rows to their canonical fixture values. This does
-- not remove unrelated or leftover test data; it is not a database reset.

INSERT INTO roles (role_id, role_name, description) VALUES
  (1, 'admin', 'Synthetic integration-test administrator'),
  (2, 'doctor', 'Synthetic integration-test doctor'),
  (3, 'receptionist', 'Synthetic integration-test receptionist'),
  (4, 'patient', 'Synthetic integration-test patient')
ON DUPLICATE KEY UPDATE
  role_name = VALUES(role_name), description = VALUES(description);

INSERT INTO departments (department_id, name, description, location, is_active) VALUES
  (10, 'Test Cardiology', 'Synthetic test department', 'Test location', TRUE),
  (20, 'Test Neurology', 'Synthetic test department', 'Test location', TRUE)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description), location = VALUES(location), is_active = VALUES(is_active);

INSERT INTO users (user_id, role_id, first_name, last_name, email, phone, password_hash, token_version, is_active) VALUES
  (101, 1, 'Test', 'Administrator', 'admin@hms.test', '+10000000101', '!test-seed-login-disabled!', 0, TRUE),
  (102, 2, 'Test', 'Doctor One', 'r.verma@hms.test', '+10000000102', '!test-seed-login-disabled!', 0, TRUE),
  (103, 2, 'Test', 'Doctor Two', 's.iyer@hms.test', '+10000000103', '!test-seed-login-disabled!', 0, TRUE),
  (104, 3, 'Test', 'Receptionist', 'n.fernandes@hms.test', '+10000000104', '!test-seed-login-disabled!', 0, TRUE),
  (105, 4, 'Test', 'Patient One', 'karan.shah@hms.test', '+10000000105', '!test-seed-login-disabled!', 0, TRUE),
  (106, 4, 'Test', 'Patient Two', 'priya.nair@hms.test', '+10000000106', '!test-seed-login-disabled!', 0, TRUE)
ON DUPLICATE KEY UPDATE
  role_id = VALUES(role_id), first_name = VALUES(first_name), last_name = VALUES(last_name),
  email = VALUES(email), phone = VALUES(phone), password_hash = VALUES(password_hash),
  token_version = VALUES(token_version), is_active = VALUES(is_active);

INSERT INTO doctors (doctor_id, user_id, department_id, specialization, qualification, experience_years, license_number, consultation_fee, bio, is_available) VALUES
  (201, 102, 10, 'Test Cardiology', 'Test Medical Degree', 5, 'TEST-LICENSE-201', 0.00, 'Synthetic test doctor', TRUE),
  (202, 103, 20, 'Test Neurology', 'Test Medical Degree', 7, 'TEST-LICENSE-202', 0.00, 'Synthetic test doctor', TRUE)
ON DUPLICATE KEY UPDATE
  user_id = VALUES(user_id), department_id = VALUES(department_id), specialization = VALUES(specialization),
  qualification = VALUES(qualification), experience_years = VALUES(experience_years),
  license_number = VALUES(license_number), consultation_fee = VALUES(consultation_fee),
  bio = VALUES(bio), is_available = VALUES(is_available);

INSERT INTO doctor_schedules (schedule_id, doctor_id, day_of_week, start_time, end_time, slot_minutes, is_active) VALUES
  (301, 201, 1, '09:00:00', '17:00:00', 30, TRUE),
  (302, 202, 2, '09:00:00', '17:00:00', 30, TRUE)
ON DUPLICATE KEY UPDATE
  doctor_id = VALUES(doctor_id), day_of_week = VALUES(day_of_week), start_time = VALUES(start_time),
  end_time = VALUES(end_time), slot_minutes = VALUES(slot_minutes), is_active = VALUES(is_active);

INSERT INTO patients (patient_id, user_id, date_of_birth, gender, blood_group, address_line1, city, state, postal_code, country, registration_number) VALUES
  (401, 105, '1990-01-01', 'other', 'unknown', 'Test Address One', 'Test City', 'Test State', '00001', 'Test Country', 'TEST-REG-401'),
  (402, 106, '1991-01-01', 'other', 'unknown', 'Test Address Two', 'Test City', 'Test State', '00002', 'Test Country', 'TEST-REG-402')
ON DUPLICATE KEY UPDATE
  user_id = VALUES(user_id), date_of_birth = VALUES(date_of_birth), gender = VALUES(gender),
  blood_group = VALUES(blood_group), address_line1 = VALUES(address_line1), city = VALUES(city),
  state = VALUES(state), postal_code = VALUES(postal_code), country = VALUES(country),
  registration_number = VALUES(registration_number);

INSERT INTO medical_records (record_id, patient_id, doctor_id, appointment_id, visit_date, symptoms, diagnosis, treatment_notes, follow_up_date) VALUES
  (701, 401, 201, NULL, '2026-01-01', 'Synthetic test symptom', 'Synthetic test diagnosis', 'Synthetic test note', NULL)
ON DUPLICATE KEY UPDATE
  patient_id = VALUES(patient_id), doctor_id = VALUES(doctor_id), appointment_id = VALUES(appointment_id),
  visit_date = VALUES(visit_date), symptoms = VALUES(symptoms), diagnosis = VALUES(diagnosis),
  treatment_notes = VALUES(treatment_notes), follow_up_date = VALUES(follow_up_date);
