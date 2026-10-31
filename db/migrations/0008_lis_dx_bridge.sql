-- ============================================================
-- MyRx LIS ↔ DX bridge — Migration 0008
-- Lets a lab that runs MyRx LIS Lite take DX orders into its normal
-- workflow and send released results back to DX automatically.
-- ============================================================

-- The DX user the LIS acts as when talking to DX (an integration_service
-- member of the lab's DX organisation).
ALTER TABLE lis.labs ADD COLUMN dx_service_user_id uuid REFERENCES public.users(id);
ALTER TABLE lis.labs ADD CONSTRAINT labs_dx_link_complete
    CHECK ((dx_organisation_id IS NULL) = (dx_service_user_id IS NULL));
ALTER TABLE lis.labs ADD CONSTRAINT labs_dx_organisation_fk
    FOREIGN KEY (dx_organisation_id) REFERENCES public.organisations(id);

-- Which DX assignment an ordered test fulfils (one test per assignment).
ALTER TABLE lis.order_tests ADD COLUMN dx_assignment_id uuid UNIQUE REFERENCES public.assignment_attempts(id);

-- What has been sent to DX, so a retry never sends the same thing twice and
-- later release changes (e.g. paid) can be passed on.
CREATE TABLE lis.dx_submissions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id                uuid NOT NULL REFERENCES lis.labs(id),
    report_id             uuid NOT NULL REFERENCES lis.reports(id),
    order_test_id         uuid NOT NULL REFERENCES lis.order_tests(id),
    dx_report_version_id  uuid NOT NULL REFERENCES public.report_versions(id),
    submitted_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (report_id, order_test_id)
);
