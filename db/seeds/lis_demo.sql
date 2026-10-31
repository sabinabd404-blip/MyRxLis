-- ============================================================
-- Demo data for local development and demos. Synthetic only.
--
-- Reference ranges below are ILLUSTRATIVE placeholders for testing
-- the software. They are not clinical reference intervals; each lab
-- must enter the ranges validated for its own methods and analysers.
-- ============================================================

INSERT INTO lis.labs (id, code, name, name_bn, address, phone, billing_enabled, hold_report_until_paid)
VALUES ('00000000-0000-4000-8000-000000000001', 'DEMO', 'MyRx Demo Diagnostic Centre',
        'মাইআরএক্স ডেমো ডায়াগনস্টিক সেন্টার', 'Dhanmondi, Dhaka', '+8801700000000', true, true);

INSERT INTO lis.staff_users (lab_id, username, full_name, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'admin',     'Demo Admin',        'admin'),
  ('00000000-0000-4000-8000-000000000001', 'reception', 'Demo Receptionist', 'receptionist'),
  ('00000000-0000-4000-8000-000000000001', 'tech',      'Demo Technologist', 'technologist'),
  ('00000000-0000-4000-8000-000000000001', 'path',      'Demo Pathologist',  'pathologist');

INSERT INTO lis.departments (lab_id, code, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'BIO', 'Biochemistry'),
  ('00000000-0000-4000-8000-000000000001', 'HAEM', 'Haematology'),
  ('00000000-0000-4000-8000-000000000001', 'IMM', 'Immunology');

INSERT INTO lis.referring_doctors (lab_id, name, qualification) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Dr. Demo Endocrinologist', 'MBBS, FCPS'),
  ('00000000-0000-4000-8000-000000000001', 'Dr. Demo Physician', 'MBBS, MD');

-- Tests: (code, name, department, specimen, price BDT, MyRx code, LOINC)
WITH lab AS (SELECT '00000000-0000-4000-8000-000000000001'::uuid AS id),
t(code, name, dept, specimen, price, myrx, loinc, sort) AS (VALUES
  ('FBS',   'Fasting blood sugar',        'BIO',  'Fluoride plasma', 200,  'MRX-FBS',   '1558-6',  10),
  ('HBA1C', 'HbA1c',                      'BIO',  'EDTA whole blood', 1200, 'MRX-HBA1C', '4548-4',  20),
  ('CREAT', 'Serum creatinine',           'BIO',  'Serum',           400,  'MRX-CREAT', '2160-0',  30),
  ('LIPID', 'Lipid profile (fasting)',    'BIO',  'Serum',           1500, 'MRX-LIPID', '57698-3', 40),
  ('TSH',   'TSH',                        'IMM',  'Serum',           900,  'MRX-TSH',   '3016-3',  50),
  ('CBC',   'Complete blood count',       'HAEM', 'EDTA whole blood', 500,  'MRX-CBC',   '58410-2', 60)
)
INSERT INTO lis.tests (lab_id, department_id, code, name, specimen_type, price, myrx_test_code, loinc_code, sort_order)
SELECT lab.id, d.id, t.code, t.name, t.specimen, t.price, t.myrx, t.loinc, t.sort
FROM t CROSS JOIN lab JOIN lis.departments d ON d.lab_id = lab.id AND d.code = t.dept;

-- Parameters: (test, code, name, unit, decimals, low, high, sort)
WITH p(test, code, name, unit, decimals, low, high, sort) AS (VALUES
  ('FBS',   'GLU',  'Glucose (fasting)',       'mmol/L',     1, 3.9,  5.5,  1),
  ('HBA1C', 'A1C',  'HbA1c',                   '%',          1, 4.0,  5.6,  1),
  ('CREAT', 'CRE',  'Creatinine',              'mg/dL',      2, 0.6,  1.2,  1),
  ('LIPID', 'CHOL', 'Total cholesterol',       'mg/dL',      0, NULL, 200,  1),
  ('LIPID', 'TG',   'Triglycerides',           'mg/dL',      0, NULL, 150,  2),
  ('LIPID', 'HDL',  'HDL cholesterol',         'mg/dL',      0, 40,   NULL, 3),
  ('LIPID', 'LDL',  'LDL cholesterol',         'mg/dL',      0, NULL, 100,  4),
  ('TSH',   'TSH',  'TSH',                     'mIU/L',      2, 0.4,  4.0,  1),
  ('CBC',   'HB',   'Haemoglobin',             'g/dL',       1, 12.0, 16.0, 1),
  ('CBC',   'WBC',  'Total WBC count',         'x10^9/L',    1, 4.0,  11.0, 2),
  ('CBC',   'PLT',  'Platelet count',          'x10^9/L',    0, 150,  450,  3)
),
ins AS (
  INSERT INTO lis.test_parameters (test_id, code, name, result_type, unit, decimals, sort_order)
  SELECT t.id, p.code, p.name, 'numeric', p.unit, p.decimals, p.sort
  FROM p JOIN lis.tests t ON t.code = p.test AND t.lab_id = '00000000-0000-4000-8000-000000000001'
  RETURNING id, test_id, code
)
INSERT INTO lis.reference_ranges (parameter_id, low, high)
SELECT ins.id, p.low, p.high
FROM ins JOIN lis.tests t ON t.id = ins.test_id JOIN p ON p.test = t.code AND p.code = ins.code;

INSERT INTO lis.patients (lab_id, patient_code, full_name, sex, date_of_birth, phone) VALUES
  ('00000000-0000-4000-8000-000000000001', 'P-000001', 'Demo Patient One', 'female', '1985-04-12', '+8801711111111'),
  ('00000000-0000-4000-8000-000000000001', 'P-000002', 'Demo Patient Two', 'male',   '1970-11-03', '+8801722222222');
