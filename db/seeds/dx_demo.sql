-- Synthetic-only MyRx DX development data (from MyRx_DX_Database_Foundation_v0.1/seed_demo.sql).
INSERT INTO organisations(organisation_code,legal_name,display_name,organisation_type) VALUES
 ('MYRX-DEMO-CHAMBER','MyRx Demo Chamber Ltd.','Demo Chamber','clinic'),
 ('LAB-DEMO-A','Demo Diagnostic Centre A Ltd.','Demo Lab A','diagnostic_centre'),
 ('LAB-DEMO-B','Demo Laboratory B Ltd.','Demo Lab B','laboratory'),
 ('LAB-DEMO-C','Demo Diagnostic Centre C Ltd.','Demo Lab C','diagnostic_centre') ON CONFLICT(organisation_code) DO NOTHING;
INSERT INTO branches(organisation_id,branch_code,name,address_text)
 SELECT id,'MAIN',display_name||' Main Branch','Synthetic demo address' FROM organisations
 WHERE organisation_code IN ('MYRX-DEMO-CHAMBER','LAB-DEMO-A','LAB-DEMO-B','LAB-DEMO-C') ON CONFLICT(organisation_id,branch_code) DO NOTHING;
INSERT INTO users(external_user_ref,display_name,email,phone) VALUES
 ('demo-clinician-001','Demo Clinician','clinician@example.invalid','+8801000000001'),
 ('demo-lab-a-001','Demo Lab A Operator','lab-a@example.invalid','+8801000000002'),
 ('demo-lab-b-001','Demo Lab B Operator','lab-b@example.invalid','+8801000000003') ON CONFLICT(external_user_ref) DO NOTHING;
INSERT INTO organisation_memberships(organisation_id,user_id,role_code)
 SELECT o.id,u.id,x.role_code FROM (VALUES
 ('MYRX-DEMO-CHAMBER','demo-clinician-001','clinician'),('LAB-DEMO-A','demo-lab-a-001','lab_operator'),('LAB-DEMO-B','demo-lab-b-001','lab_operator')
 ) x(org_code,user_ref,role_code) JOIN organisations o ON o.organisation_code=x.org_code JOIN users u ON u.external_user_ref=x.user_ref
 ON CONFLICT(organisation_id,user_id,role_code) DO NOTHING;
INSERT INTO patient_identity_refs(identity_system,identity_value) VALUES('urn:myrx:demo-patient-id','DEMO-PATIENT-0001') ON CONFLICT(identity_system,identity_value) DO NOTHING;
INSERT INTO catalogue_tests(canonical_code,display_name,specimen_type,unit_of_measure,clinical_category) VALUES
 ('MYRX-LAB-GLU','Glucose','Blood','mmol/L','biochemistry'),('MYRX-LAB-CREA','Creatinine','Serum','mg/dL','renal'),('MYRX-LAB-HBA1C','HbA1c','Whole blood','%','diabetes') ON CONFLICT(canonical_code) DO NOTHING;
INSERT INTO lab_service_offers(organisation_id,branch_id,catalogue_test_id,local_test_code,local_test_name,price_amount,currency_code,estimated_turnaround_minutes)
 SELECT o.id,b.id,t.id,CASE t.canonical_code WHEN 'MYRX-LAB-GLU' THEN 'A-GLU' WHEN 'MYRX-LAB-CREA' THEN 'A-CREA' ELSE 'A-HBA1C' END,t.display_name,250,'BDT',240
 FROM organisations o JOIN branches b ON b.organisation_id=o.id AND b.branch_code='MAIN' CROSS JOIN catalogue_tests t
 WHERE o.organisation_code='LAB-DEMO-A' AND t.canonical_code IN ('MYRX-LAB-GLU','MYRX-LAB-CREA','MYRX-LAB-HBA1C') ON CONFLICT(branch_id,local_test_code) DO NOTHING;
INSERT INTO lab_service_offers(organisation_id,branch_id,catalogue_test_id,local_test_code,local_test_name,price_amount,currency_code,estimated_turnaround_minutes)
 SELECT o.id,b.id,t.id,CASE t.canonical_code WHEN 'MYRX-LAB-GLU' THEN 'B-GLU' WHEN 'MYRX-LAB-CREA' THEN 'B-CREA' ELSE 'B-HBA1C' END,t.display_name,275,'BDT',300
 FROM organisations o JOIN branches b ON b.organisation_id=o.id AND b.branch_code='MAIN' CROSS JOIN catalogue_tests t
 WHERE o.organisation_code='LAB-DEMO-B' AND t.canonical_code IN ('MYRX-LAB-GLU','MYRX-LAB-CREA','MYRX-LAB-HBA1C') ON CONFLICT(branch_id,local_test_code) DO NOTHING;
