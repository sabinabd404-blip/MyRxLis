-- ============================================================
-- MyRx DX — Migration 0002: database foundation v0.1
-- Imported unchanged from MyRx_DX_Database_Foundation_v0.1/schema.sql
-- (only the outer BEGIN/COMMIT removed, because the migration runner
-- wraps every migration in its own transaction).
-- DX tables live in the `public` schema; LIS tables live in `lis`.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TABLE organisations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_code text NOT NULL UNIQUE,
 legal_name text NOT NULL, display_name text NOT NULL,
 organisation_type text NOT NULL CHECK (organisation_type IN ('diagnostic_centre','laboratory','clinic','hospital','platform_operator')),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE branches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_id uuid NOT NULL REFERENCES organisations(id),
 branch_code text NOT NULL, name text NOT NULL, address_text text, phone text,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organisation_id, branch_code), UNIQUE (id, organisation_id)
);
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_user_ref text UNIQUE,
 display_name text NOT NULL, email text, phone text,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organisation_memberships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_id uuid NOT NULL REFERENCES organisations(id),
 user_id uuid NOT NULL REFERENCES users(id),
 role_code text NOT NULL CHECK (role_code IN ('org_admin','lab_manager','lab_operator','clinician','chamber_assistant','auditor','integration_service')),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organisation_id,user_id,role_code)
);
CREATE TABLE patient_identity_refs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_system text NOT NULL, identity_value text NOT NULL,
 identity_version text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(identity_system,identity_value)
);
CREATE TABLE encounters (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_system text NOT NULL, source_encounter_id text NOT NULL,
 patient_identity_ref_id uuid NOT NULL REFERENCES patient_identity_refs(id), practitioner_ref text,
 encounter_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_system,source_encounter_id)
);
CREATE TABLE catalogue_tests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_code text NOT NULL UNIQUE, display_name text NOT NULL,
 specimen_type text, unit_of_measure text, clinical_category text,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lab_service_offers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_id uuid NOT NULL REFERENCES organisations(id), branch_id uuid NOT NULL,
 catalogue_test_id uuid NOT NULL REFERENCES catalogue_tests(id), local_test_code text NOT NULL, local_test_name text NOT NULL,
 price_amount numeric(12,2) CHECK (price_amount IS NULL OR price_amount >= 0), currency_code char(3) NOT NULL DEFAULT 'BDT',
 estimated_turnaround_minutes integer CHECK (estimated_turnaround_minutes IS NULL OR estimated_turnaround_minutes >= 0),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(branch_id,organisation_id) REFERENCES branches(id,organisation_id),
 UNIQUE(branch_id,local_test_code), UNIQUE(id,organisation_id,branch_id)
);
CREATE TABLE diagnostic_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number text NOT NULL UNIQUE, source_system text NOT NULL, source_order_id text NOT NULL,
 patient_identity_ref_id uuid NOT NULL REFERENCES patient_identity_refs(id), encounter_id uuid REFERENCES encounters(id),
 ordering_organisation_id uuid REFERENCES organisations(id), ordering_practitioner_ref text, clinical_indication text,
 priority text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','stat')),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','partially_assigned','assigned','in_progress','partially_completed','completed','cancelled','entered_in_error')),
 patient_authorisation_ref text, placed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_system,source_order_id)
);
CREATE TABLE diagnostic_order_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES diagnostic_orders(id),
 line_number integer NOT NULL CHECK (line_number > 0), catalogue_test_id uuid NOT NULL REFERENCES catalogue_tests(id),
 requested_test_name text NOT NULL, requested_specimen_type text, clinical_notes text,
 status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','assigned','accepted','specimen_collected','processing','preliminary','final','corrected','rejected','cancelled','entered_in_error')),
 requested_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,line_number), UNIQUE(id,order_id)
);
CREATE TABLE assignment_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid NOT NULL REFERENCES diagnostic_order_items(id),
 lab_service_offer_id uuid NOT NULL REFERENCES lab_service_offers(id), organisation_id uuid NOT NULL REFERENCES organisations(id), branch_id uuid NOT NULL REFERENCES branches(id),
 attempt_number integer NOT NULL CHECK (attempt_number > 0),
 status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','in_progress','completed','rejected','cancelled','expired')),
 external_accession_id text, offered_at timestamptz NOT NULL DEFAULT now(), responded_at timestamptz, closed_at timestamptz,
 rejection_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(lab_service_offer_id,organisation_id,branch_id) REFERENCES lab_service_offers(id,organisation_id,branch_id),
 UNIQUE(order_item_id,attempt_number), UNIQUE(id,order_item_id),
 CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);
-- One active assignment per order item; reassignment requires closing prior attempt first.
CREATE UNIQUE INDEX uq_assignment_one_active_per_item ON assignment_attempts(order_item_id) WHERE status IN ('offered','accepted','in_progress');
CREATE INDEX ix_assignment_org_status ON assignment_attempts(organisation_id,status,offered_at DESC);
CREATE TABLE specimens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_attempt_id uuid NOT NULL REFERENCES assignment_attempts(id),
 specimen_identifier text NOT NULL, specimen_type text NOT NULL, collected_at timestamptz, received_at timestamptz,
 status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','collected','received','rejected','processing','consumed')),
 rejection_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(assignment_attempt_id,specimen_identifier)
);
CREATE TABLE result_sets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_attempt_id uuid NOT NULL REFERENCES assignment_attempts(id),
 source_result_set_id text, status text NOT NULL DEFAULT 'preliminary' CHECK (status IN ('preliminary','final','corrected','cancelled','entered_in_error')),
 result_at timestamptz, released_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(), source_system text NOT NULL,
 idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_system,idempotency_key)
);
CREATE TABLE observation_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), result_set_id uuid NOT NULL REFERENCES result_sets(id),
 order_item_id uuid NOT NULL REFERENCES diagnostic_order_items(id), observation_code text, observation_name text NOT NULL,
 value_text text, value_numeric numeric, unit_code text, reference_range_text text, interpretation_code text,
 abnormal_flag text, observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(value_text IS NOT NULL OR value_numeric IS NOT NULL)
);
CREATE INDEX ix_observation_order_item ON observation_results(order_item_id);
CREATE INDEX ix_result_sets_assignment ON result_sets(assignment_attempt_id,received_at DESC);
CREATE TABLE report_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_attempt_id uuid NOT NULL REFERENCES assignment_attempts(id),
 result_set_id uuid REFERENCES result_sets(id), version_number integer NOT NULL CHECK(version_number > 0),
 report_status text NOT NULL CHECK(report_status IN ('preliminary','final','corrected','cancelled','entered_in_error')),
 storage_object_key text NOT NULL, media_type text NOT NULL DEFAULT 'application/pdf', checksum_sha256 text,
 issued_at timestamptz, supersedes_report_version_id uuid REFERENCES report_versions(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(assignment_attempt_id,version_number), UNIQUE(id,assignment_attempt_id)
);
CREATE TABLE patient_authorisations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), patient_identity_ref_id uuid NOT NULL REFERENCES patient_identity_refs(id),
 order_id uuid REFERENCES diagnostic_orders(id), authorised_by_ref text NOT NULL, purpose text NOT NULL,
 valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_until IS NULL OR valid_until > valid_from)
);
CREATE TABLE integration_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_id uuid NOT NULL REFERENCES organisations(id), branch_id uuid,
 endpoint_name text NOT NULL, integration_type text NOT NULL CHECK(integration_type IN ('lis_api','webhook','sftp','portal','fhir_api','manual')),
 configuration_ref text, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','retired')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(branch_id,organisation_id) REFERENCES branches(id,organisation_id), UNIQUE(organisation_id,endpoint_name)
);
CREATE TABLE integration_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), endpoint_id uuid NOT NULL REFERENCES integration_endpoints(id),
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')), message_type text NOT NULL, external_message_id text,
 idempotency_key text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','succeeded','retryable_failure','permanent_failure','dead_letter')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count >= 0), next_attempt_at timestamptz, payload_object_key text,
 last_error_code text, last_error_summary text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(endpoint_id,direction,idempotency_key)
);
CREATE INDEX ix_integration_messages_retry ON integration_messages(status,next_attempt_at) WHERE status IN ('queued','retryable_failure');
CREATE TABLE audit_events (
 id bigserial PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(), actor_user_id uuid REFERENCES users(id), actor_service_ref text,
 organisation_id uuid REFERENCES organisations(id), action_code text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('success','denied','failure')), reason_code text, correlation_id text, source_ip inet,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_audit_resource_time ON audit_events(resource_type,resource_id,occurred_at DESC);
CREATE INDEX ix_audit_actor_time ON audit_events(actor_user_id,occurred_at DESC);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['organisations','branches','users','catalogue_tests','lab_service_offers','diagnostic_orders','diagnostic_order_items','assignment_attempts','specimens','integration_endpoints','integration_messages'] LOOP
  EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',t,t);
 END LOOP;
END $$;
