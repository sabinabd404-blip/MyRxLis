-- ============================================================
-- MyRx LIS — Migration 0001: core LIS Lite data model
-- Target: PostgreSQL 16
--
-- All LIS tables live in the `lis` schema. The MyRx DX exchange
-- schema (organisations, diagnostic_orders, ...) lives in `public`
-- and is imported separately, so the two never collide.
--
-- Design rules enforced here (see docs/DECISIONS.md):
--   * Every row belongs to exactly one lab. Composite foreign keys
--     (id, lab_id) stop a row from pointing at another lab's data.
--   * A result can only be stored for a parameter of the test that
--     was actually ordered.
--   * Results are locked once a test is validated or released.
--     Corrections go through an amended report version.
--   * Released report content is immutable and never deleted.
--   * Three statuses are kept apart: the test's operational status
--     (order_tests.status), the report's clinical status
--     (reports.clinical_status) and its distribution authorisation
--     (reports.distribution_status). Payment lives in invoices and
--     payments and never overwrites any of them.
-- ============================================================

CREATE SCHEMA lis;

-- ------------------------------------------------------------
-- Labs and staff
-- ------------------------------------------------------------
CREATE TABLE lis.labs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                    text NOT NULL UNIQUE,
    name                    text NOT NULL,
    name_bn                 text,
    address                 text,
    phone                   text,
    email                   text,
    -- Billing can be switched off when the lab keeps its own billing app.
    billing_enabled         boolean NOT NULL DEFAULT true,
    -- Lab policy: hold report release until the invoice is fully paid.
    hold_report_until_paid  boolean NOT NULL DEFAULT false,
    -- Link to public.organisations once the MyRx DX schema is imported.
    dx_organisation_id      uuid,
    created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lis.staff_users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id         uuid NOT NULL REFERENCES lis.labs(id),
    username       text NOT NULL,
    full_name      text NOT NULL,
    role           text NOT NULL CHECK (role IN ('admin', 'receptionist', 'technologist', 'pathologist')),
    password_hash  text,
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lab_id, username),
    UNIQUE (id, lab_id)
);

-- ------------------------------------------------------------
-- Patients and referring doctors
-- ------------------------------------------------------------
CREATE TABLE lis.patients (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id            uuid NOT NULL REFERENCES lis.labs(id),
    patient_code      text NOT NULL,
    full_name         text NOT NULL,
    full_name_bn      text,
    sex               text NOT NULL CHECK (sex IN ('male', 'female', 'other', 'unknown')),
    -- Many labs record age rather than date of birth; age at each
    -- visit is stored on the order (orders.patient_age_days).
    date_of_birth     date,
    phone             text,
    address           text,
    -- Reference to the MyRx identity record, when known.
    myrx_patient_ref  text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lab_id, patient_code),
    UNIQUE (id, lab_id)
);
CREATE INDEX patients_lab_phone_idx ON lis.patients (lab_id, phone);
CREATE INDEX patients_lab_name_idx ON lis.patients (lab_id, lower(full_name));

CREATE TABLE lis.referring_doctors (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id           uuid NOT NULL REFERENCES lis.labs(id),
    name             text NOT NULL,
    qualification    text,
    phone            text,
    bmdc_reg_no      text,
    myrx_doctor_ref  text,
    active           boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, lab_id)
);

-- ------------------------------------------------------------
-- Test catalogue
-- ------------------------------------------------------------
CREATE TABLE lis.departments (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id   uuid NOT NULL REFERENCES lis.labs(id),
    code     text NOT NULL,
    name     text NOT NULL,
    UNIQUE (lab_id, code),
    UNIQUE (id, lab_id)
);

CREATE TABLE lis.tests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id            uuid NOT NULL REFERENCES lis.labs(id),
    department_id     uuid,
    code              text NOT NULL,
    name              text NOT NULL,
    short_name        text,
    specimen_type     text,
    container         text,
    price             numeric(12,2) NOT NULL CHECK (price >= 0),
    turnaround_hours  integer CHECK (turnaround_hours > 0),
    -- Canonical MyRx test code (MyRx Test Registry), used by DX mapping.
    myrx_test_code    text,
    loinc_code        text,
    active            boolean NOT NULL DEFAULT true,
    sort_order        integer NOT NULL DEFAULT 0,
    UNIQUE (lab_id, code),
    UNIQUE (id, lab_id),
    FOREIGN KEY (department_id, lab_id) REFERENCES lis.departments (id, lab_id)
);

CREATE TABLE lis.test_parameters (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id      uuid NOT NULL REFERENCES lis.tests(id) ON DELETE CASCADE,
    code         text NOT NULL,
    name         text NOT NULL,
    result_type  text NOT NULL CHECK (result_type IN ('numeric', 'text', 'option')),
    unit         text,
    decimals     smallint CHECK (decimals BETWEEN 0 and 6),
    options      text[],
    loinc_code   text,
    sort_order   integer NOT NULL DEFAULT 0,
    UNIQUE (test_id, code),
    UNIQUE (id, test_id),
    CHECK (result_type <> 'option' OR cardinality(options) > 0)
);

CREATE TABLE lis.reference_ranges (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parameter_id   uuid NOT NULL REFERENCES lis.test_parameters(id) ON DELETE CASCADE,
    sex            text CHECK (sex IN ('male', 'female')),   -- NULL = applies to all
    age_min_days   integer NOT NULL DEFAULT 0 CHECK (age_min_days >= 0),
    age_max_days   integer,                                 -- NULL = no upper limit
    low            numeric,
    high           numeric,
    critical_low   numeric,
    critical_high  numeric,
    range_text     text,
    CHECK (age_max_days IS NULL OR age_max_days >= age_min_days),
    CHECK (low IS NULL OR high IS NULL OR low <= high),
    CHECK (low IS NOT NULL OR high IS NOT NULL OR range_text IS NOT NULL)
);
CREATE INDEX reference_ranges_parameter_idx ON lis.reference_ranges (parameter_id);

-- ------------------------------------------------------------
-- Orders, ordered tests and specimens
-- ------------------------------------------------------------
CREATE TABLE lis.orders (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id               uuid NOT NULL REFERENCES lis.labs(id),
    order_number         text NOT NULL,
    patient_id           uuid NOT NULL,
    referring_doctor_id  uuid,
    patient_age_days     integer NOT NULL CHECK (patient_age_days BETWEEN 0 AND 55000),
    source               text NOT NULL DEFAULT 'walk_in' CHECK (source IN ('walk_in', 'myrx_dx')),
    -- For DX orders: the DX order reference. Unique per lab and source,
    -- so a retried DX message cannot create a duplicate order.
    external_ref         text,
    ordered_by           uuid,
    ordered_at           timestamptz NOT NULL DEFAULT now(),
    notes                text,
    UNIQUE (lab_id, order_number),
    UNIQUE (id, lab_id),
    CHECK (source = 'walk_in' OR external_ref IS NOT NULL),
    FOREIGN KEY (patient_id, lab_id)          REFERENCES lis.patients (id, lab_id),
    FOREIGN KEY (referring_doctor_id, lab_id) REFERENCES lis.referring_doctors (id, lab_id),
    FOREIGN KEY (ordered_by, lab_id)          REFERENCES lis.staff_users (id, lab_id)
);
CREATE UNIQUE INDEX orders_external_ref_uq ON lis.orders (lab_id, source, external_ref)
    WHERE external_ref IS NOT NULL;
CREATE INDEX orders_patient_idx ON lis.orders (patient_id);
CREATE INDEX orders_lab_date_idx ON lis.orders (lab_id, ordered_at DESC);

CREATE TABLE lis.specimens (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id            uuid NOT NULL,
    order_id          uuid NOT NULL,
    barcode           text NOT NULL,
    specimen_type     text NOT NULL,
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'collected', 'received', 'rejected')),
    collected_at      timestamptz,
    collected_by      uuid,
    received_at       timestamptz,
    received_by       uuid,
    rejection_reason  text,
    UNIQUE (lab_id, barcode),
    UNIQUE (id, order_id),
    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),
    FOREIGN KEY (order_id, lab_id)     REFERENCES lis.orders (id, lab_id),
    FOREIGN KEY (collected_by, lab_id) REFERENCES lis.staff_users (id, lab_id),
    FOREIGN KEY (received_by, lab_id)  REFERENCES lis.staff_users (id, lab_id)
);
CREATE INDEX specimens_order_idx ON lis.specimens (order_id);

CREATE TABLE lis.order_tests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id            uuid NOT NULL,
    order_id          uuid NOT NULL,
    test_id           uuid NOT NULL,
    price             numeric(12,2) NOT NULL CHECK (price >= 0),
    status            text NOT NULL DEFAULT 'ordered'
                      CHECK (status IN ('ordered', 'collected', 'in_progress', 'resulted',
                                        'validated', 'released', 'cancelled')),
    specimen_id       uuid,
    cancelled_reason  text,
    UNIQUE (order_id, test_id),
    UNIQUE (id, test_id),
    UNIQUE (id, order_id),
    CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL),
    FOREIGN KEY (order_id, lab_id)    REFERENCES lis.orders (id, lab_id),
    FOREIGN KEY (test_id, lab_id)     REFERENCES lis.tests (id, lab_id),
    FOREIGN KEY (specimen_id, order_id) REFERENCES lis.specimens (id, order_id)
);
CREATE INDEX order_tests_lab_status_idx ON lis.order_tests (lab_id, status);

-- Allowed operational status transitions for an ordered test.
CREATE FUNCTION lis.check_order_test_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF NOT (
        (OLD.status = 'ordered'     AND NEW.status IN ('collected', 'in_progress', 'cancelled')) OR
        (OLD.status = 'collected'   AND NEW.status IN ('in_progress', 'resulted', 'cancelled')) OR
        (OLD.status = 'in_progress' AND NEW.status IN ('resulted', 'cancelled')) OR
        (OLD.status = 'resulted'    AND NEW.status IN ('validated', 'in_progress')) OR
        (OLD.status = 'validated'   AND NEW.status IN ('released', 'resulted')) OR
        -- released -> resulted reopens results for an amended report.
        (OLD.status = 'released'    AND NEW.status = 'resulted')
    ) THEN
        RAISE EXCEPTION 'Invalid test status change: % -> %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_order_test_transition
    BEFORE UPDATE OF status ON lis.order_tests
    FOR EACH ROW EXECUTE FUNCTION lis.check_order_test_transition();

-- ------------------------------------------------------------
-- Results
-- ------------------------------------------------------------
CREATE TABLE lis.results (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_test_id   uuid NOT NULL,
    test_id         uuid NOT NULL,
    parameter_id    uuid NOT NULL,
    value_numeric   numeric,
    value_text      text,
    unit            text,
    -- Reference range snapshot taken when the result was entered, so a
    -- later catalogue change never rewrites a past result.
    ref_low         numeric,
    ref_high        numeric,
    ref_text        text,
    flag            text CHECK (flag IN ('N', 'L', 'H', 'LL', 'HH', 'A')),
    entered_by      uuid,
    entered_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_test_id, parameter_id),
    CHECK (value_numeric IS NOT NULL OR value_text IS NOT NULL),
    FOREIGN KEY (order_test_id, test_id) REFERENCES lis.order_tests (id, test_id),
    FOREIGN KEY (parameter_id, test_id)  REFERENCES lis.test_parameters (id, test_id),
    FOREIGN KEY (entered_by)             REFERENCES lis.staff_users (id)
);

-- Results cannot change once their test is validated or released.
CREATE FUNCTION lis.check_result_editable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_status text;
    v_order_test uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_test_id ELSE NEW.order_test_id END;
BEGIN
    SELECT status INTO v_status FROM lis.order_tests WHERE id = v_order_test;
    IF v_status IN ('validated', 'released', 'cancelled') THEN
        RAISE EXCEPTION 'Results are locked: test status is %', v_status
            USING ERRCODE = 'check_violation',
                  HINT = 'Reopen the test (status resulted) and issue an amended report.';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_result_editable
    BEFORE INSERT OR UPDATE OR DELETE ON lis.results
    FOR EACH ROW EXECUTE FUNCTION lis.check_result_editable();

-- ------------------------------------------------------------
-- Billing (optional per lab: labs.billing_enabled)
-- ------------------------------------------------------------
CREATE TABLE lis.invoices (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id      uuid NOT NULL,
    order_id    uuid NOT NULL UNIQUE,
    gross       numeric(12,2) NOT NULL CHECK (gross >= 0),
    discount    numeric(12,2) NOT NULL DEFAULT 0,
    net         numeric(12,2) GENERATED ALWAYS AS (gross - discount) STORED,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, lab_id),
    CHECK (discount >= 0 AND discount <= gross),
    FOREIGN KEY (order_id, lab_id) REFERENCES lis.orders (id, lab_id)
);

CREATE TABLE lis.payments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id          uuid NOT NULL,
    invoice_id      uuid NOT NULL,
    kind            text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'refund')),
    amount          numeric(12,2) NOT NULL CHECK (amount > 0),
    method          text NOT NULL CHECK (method IN ('cash', 'card', 'bkash', 'nagad', 'rocket', 'bank', 'other')),
    -- Money receipt number printed for the patient.
    receipt_number  text NOT NULL,
    received_by     uuid,
    received_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lab_id, receipt_number),
    FOREIGN KEY (invoice_id, lab_id)  REFERENCES lis.invoices (id, lab_id),
    FOREIGN KEY (received_by, lab_id) REFERENCES lis.staff_users (id, lab_id)
);
CREATE INDEX payments_invoice_idx ON lis.payments (invoice_id);

CREATE VIEW lis.invoice_balances AS
SELECT i.id AS invoice_id,
       i.lab_id,
       i.order_id,
       i.net,
       COALESCE(SUM(CASE p.kind WHEN 'payment' THEN p.amount ELSE -p.amount END), 0)::numeric(12,2) AS paid,
       (i.net - COALESCE(SUM(CASE p.kind WHEN 'payment' THEN p.amount ELSE -p.amount END), 0))::numeric(12,2) AS due
FROM lis.invoices i
LEFT JOIN lis.payments p ON p.invoice_id = i.id
GROUP BY i.id;

-- ------------------------------------------------------------
-- Reports
-- ------------------------------------------------------------
CREATE TABLE lis.reports (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id               uuid NOT NULL,
    order_id             uuid NOT NULL,
    version              integer NOT NULL CHECK (version >= 1),
    supersedes_id        uuid,
    clinical_status      text NOT NULL DEFAULT 'preliminary'
                         CHECK (clinical_status IN ('preliminary', 'final', 'amended')),
    -- Distribution authorisation, decided by the lab's release policy.
    distribution_status  text NOT NULL DEFAULT 'held'
                         CHECK (distribution_status IN ('held', 'authorised', 'restricted')),
    distribution_reason  text,
    amendment_reason     text,
    validated_by         uuid,
    validated_at         timestamptz,
    released_by          uuid,
    released_at          timestamptz,
    -- Snapshot of exactly what was released (patient, tests, results, ranges).
    content              jsonb,
    pdf_object_key       text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, version),
    UNIQUE (id, order_id),
    CHECK (version = 1 OR (supersedes_id IS NOT NULL AND amendment_reason IS NOT NULL)),
    CHECK (released_at IS NULL OR (content IS NOT NULL AND released_by IS NOT NULL)),
    CHECK (distribution_status <> 'restricted' OR distribution_reason IS NOT NULL),
    FOREIGN KEY (order_id, lab_id)        REFERENCES lis.orders (id, lab_id),
    FOREIGN KEY (supersedes_id, order_id) REFERENCES lis.reports (id, order_id),
    FOREIGN KEY (validated_by, lab_id)    REFERENCES lis.staff_users (id, lab_id),
    FOREIGN KEY (released_by, lab_id)     REFERENCES lis.staff_users (id, lab_id)
);

-- Which ordered tests a report covers (departments may release separately).
CREATE TABLE lis.report_items (
    report_id      uuid NOT NULL,
    order_id       uuid NOT NULL,
    order_test_id  uuid NOT NULL,
    PRIMARY KEY (report_id, order_test_id),
    FOREIGN KEY (report_id, order_id)     REFERENCES lis.reports (id, order_id),
    FOREIGN KEY (order_test_id, order_id) REFERENCES lis.order_tests (id, order_id)
);

-- A released report is a legal record: its content never changes and it
-- is never deleted. Only the distribution authorisation may change.
CREATE FUNCTION lis.protect_released_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.released_at IS NOT NULL THEN
            RAISE EXCEPTION 'Released report % cannot be deleted', OLD.id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.released_at IS NOT NULL AND (
           NEW.lab_id           IS DISTINCT FROM OLD.lab_id
        OR NEW.order_id         IS DISTINCT FROM OLD.order_id
        OR NEW.version          IS DISTINCT FROM OLD.version
        OR NEW.supersedes_id    IS DISTINCT FROM OLD.supersedes_id
        OR NEW.clinical_status  IS DISTINCT FROM OLD.clinical_status
        OR NEW.amendment_reason IS DISTINCT FROM OLD.amendment_reason
        OR NEW.validated_by     IS DISTINCT FROM OLD.validated_by
        OR NEW.validated_at     IS DISTINCT FROM OLD.validated_at
        OR NEW.released_by      IS DISTINCT FROM OLD.released_by
        OR NEW.released_at      IS DISTINCT FROM OLD.released_at
        OR NEW.content          IS DISTINCT FROM OLD.content
        OR NEW.pdf_object_key   IS DISTINCT FROM OLD.pdf_object_key
    ) THEN
        RAISE EXCEPTION 'Released report % is immutable; issue an amended version instead', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protect_released_report
    BEFORE UPDATE OR DELETE ON lis.reports
    FOR EACH ROW EXECUTE FUNCTION lis.protect_released_report();

CREATE FUNCTION lis.protect_released_report_items() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_report uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.report_id ELSE OLD.report_id END;
BEGIN
    IF EXISTS (SELECT 1 FROM lis.reports WHERE id = v_report AND released_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Items of released report % cannot change', v_report
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_protect_released_report_items
    BEFORE INSERT OR UPDATE OR DELETE ON lis.report_items
    FOR EACH ROW EXECUTE FUNCTION lis.protect_released_report_items();

-- ------------------------------------------------------------
-- Audit trail
-- The application sets the acting user per transaction with:
--   SELECT set_config('lis.actor', '<staff user id or name>', true);
-- ------------------------------------------------------------
CREATE TABLE lis.audit_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name  text NOT NULL,
    row_id      uuid,
    action      text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    actor       text,
    old_row     jsonb,
    new_row     jsonb,
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_row_idx ON lis.audit_events (table_name, row_id);

CREATE FUNCTION lis.write_audit_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO lis.audit_events (table_name, row_id, action, actor, old_row, new_row)
    VALUES (
        TG_TABLE_NAME,
        CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
        TG_OP,
        NULLIF(current_setting('lis.actor', true), ''),
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
    );
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_audit_patients    AFTER INSERT OR UPDATE OR DELETE ON lis.patients    FOR EACH ROW EXECUTE FUNCTION lis.write_audit_event();
CREATE TRIGGER trg_audit_orders      AFTER INSERT OR UPDATE OR DELETE ON lis.orders      FOR EACH ROW EXECUTE FUNCTION lis.write_audit_event();
CREATE TRIGGER trg_audit_order_tests AFTER INSERT OR UPDATE OR DELETE ON lis.order_tests FOR EACH ROW EXECUTE FUNCTION lis.write_audit_event();
CREATE TRIGGER trg_audit_specimens   AFTER INSERT OR UPDATE OR DELETE ON lis.specimens   FOR EACH ROW EXECUTE FUNCTION lis.write_audit_event();
CREATE TRIGGER trg_audit_results     AFTER INSERT OR UPDATE OR DELETE ON lis.results     FOR EACH ROW EXECUTE FUNCTION lis.write_audit_event();
CREATE TRIGGER trg_audit_invoices    AFTER INSERT OR UPDATE OR DELETE ON lis.invoices    FOR EACH ROW EXECUTE FUNCTION lis.write_audit_event();
CREATE TRIGGER trg_audit_payments    AFTER INSERT OR UPDATE OR DELETE ON lis.payments    FOR EACH ROW EXECUTE FUNCTION lis.write_audit_event();
CREATE TRIGGER trg_audit_reports     AFTER INSERT OR UPDATE OR DELETE ON lis.reports     FOR EACH ROW EXECUTE FUNCTION lis.write_audit_event();

-- The audit trail itself is append-only.
CREATE FUNCTION lis.audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON lis.audit_events
    FOR EACH ROW EXECUTE FUNCTION lis.audit_append_only();
