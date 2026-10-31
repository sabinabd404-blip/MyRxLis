-- ============================================================
-- MyRx DX — Migration 0003: integrity hardening
-- Equivalent to migration_001_integrity_hardening.sql as applied to
-- myrx_dx_dev, plus the report supersession constraint that was added
-- afterwards by hand (report_versions_supersedes_same_assignment_fk).
--
-- Protections:
--   1. Assignment must match the requested test and the lab offer.
--   2. Observation must match the assigned order item.
--   3. Report and result set must belong to the same assignment.
--   4. Order and encounter must reference the same patient.
--   5. Authorisation and linked order must reference the same patient.
--   6. Report versions cannot be updated or deleted.
--   7. A report can only supersede a report of the same assignment.
-- ============================================================

-- 1. Assignment integrity
CREATE OR REPLACE FUNCTION dx_check_assignment_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM diagnostic_order_items doi
        JOIN lab_service_offers lso ON lso.id = NEW.lab_service_offer_id
        WHERE doi.id = NEW.order_item_id
          AND doi.catalogue_test_id = lso.catalogue_test_id
          AND lso.organisation_id = NEW.organisation_id
          AND lso.branch_id = NEW.branch_id
    ) THEN
        RAISE EXCEPTION 'Assignment rejected: order item, test offer, organisation or branch does not match.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dx_assignment_integrity
    BEFORE INSERT OR UPDATE ON assignment_attempts
    FOR EACH ROW EXECUTE FUNCTION dx_check_assignment_integrity();

-- 2. Observation integrity
CREATE OR REPLACE FUNCTION dx_check_observation_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM result_sets rs
        JOIN assignment_attempts aa ON aa.id = rs.assignment_attempt_id
        WHERE rs.id = NEW.result_set_id
          AND aa.order_item_id = NEW.order_item_id
    ) THEN
        RAISE EXCEPTION 'Observation rejected: result set and order item do not match.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dx_observation_integrity
    BEFORE INSERT OR UPDATE ON observation_results
    FOR EACH ROW EXECUTE FUNCTION dx_check_observation_integrity();

-- 3. Report integrity
CREATE OR REPLACE FUNCTION dx_check_report_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.result_set_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM result_sets rs
        WHERE rs.id = NEW.result_set_id
          AND rs.assignment_attempt_id = NEW.assignment_attempt_id
    ) THEN
        RAISE EXCEPTION 'Report rejected: report and result set belong to different assignments.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dx_report_integrity
    BEFORE INSERT OR UPDATE ON report_versions
    FOR EACH ROW EXECUTE FUNCTION dx_check_report_integrity();

-- 4. Order and encounter patient integrity
CREATE OR REPLACE FUNCTION dx_check_order_encounter_patient()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.encounter_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM encounters e
        WHERE e.id = NEW.encounter_id
          AND e.patient_identity_ref_id = NEW.patient_identity_ref_id
    ) THEN
        RAISE EXCEPTION 'Order rejected: order patient does not match encounter patient.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dx_order_encounter_patient
    BEFORE INSERT OR UPDATE ON diagnostic_orders
    FOR EACH ROW EXECUTE FUNCTION dx_check_order_encounter_patient();

-- 5. Authorisation patient integrity
CREATE OR REPLACE FUNCTION dx_check_authorisation_patient()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.order_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM diagnostic_orders d
        WHERE d.id = NEW.order_id
          AND d.patient_identity_ref_id = NEW.patient_identity_ref_id
    ) THEN
        RAISE EXCEPTION 'Authorisation rejected: authorisation patient does not match order patient.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dx_authorisation_patient
    BEFORE INSERT OR UPDATE ON patient_authorisations
    FOR EACH ROW EXECUTE FUNCTION dx_check_authorisation_patient();

-- 6. Report version immutability
CREATE OR REPLACE FUNCTION dx_prevent_report_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Report versions are immutable. Insert a new version instead.'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_dx_report_version_immutable
    BEFORE UPDATE OR DELETE ON report_versions
    FOR EACH ROW EXECUTE FUNCTION dx_prevent_report_version_mutation();

-- 7. Supersession stays within one assignment
ALTER TABLE report_versions
    ADD CONSTRAINT report_versions_supersedes_same_assignment_fk
    FOREIGN KEY (supersedes_report_version_id, assignment_attempt_id)
    REFERENCES report_versions (id, assignment_attempt_id);
