-- ============================================================
-- MyRx DX — Migration 0005: report release decisions
-- Report versions are immutable, so the lab's distribution decision is
-- recorded separately as an append-only log. The current decision for a
-- report version is the latest row. This keeps three things apart:
--   * the report's clinical status   (report_versions.report_status)
--   * its distribution authorisation (report_release_decisions.decision)
--   * the lab's billing state, which DX never stores; a lab may give
--     'awaiting_payment' as the reason for holding a report.
-- DX must only deliver a report to a doctor's EMR while its current
-- decision is 'authorised'.
-- ============================================================

CREATE TABLE report_release_decisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Monotonic order of decisions, also within one transaction.
    seq                 bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    report_version_id   uuid NOT NULL REFERENCES report_versions(id),
    decision            text NOT NULL CHECK (decision IN ('held', 'authorised', 'restricted')),
    reason_code         text CHECK (reason_code IN ('awaiting_payment', 'pending_review', 'lab_policy',
                                                    'patient_request', 'legal', 'other')),
    reason_text         text,
    decided_by_user_id  uuid REFERENCES users(id),
    decided_by_service  text,
    decided_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (decision = 'authorised' OR reason_code IS NOT NULL),
    CHECK (decided_by_user_id IS NOT NULL OR decided_by_service IS NOT NULL)
);
CREATE INDEX ix_release_decisions_report ON report_release_decisions (report_version_id, seq DESC);

CREATE OR REPLACE FUNCTION dx_release_decisions_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Release decisions are append-only; record a new decision instead.'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_dx_release_decisions_append_only
    BEFORE UPDATE OR DELETE ON report_release_decisions
    FOR EACH ROW EXECUTE FUNCTION dx_release_decisions_append_only();

-- Current decision per report version; no row means 'held' (nothing authorised yet).
CREATE VIEW report_release_status AS
SELECT rv.id AS report_version_id,
       COALESCE(d.decision, 'held') AS decision,
       d.reason_code,
       d.decided_at
FROM report_versions rv
LEFT JOIN LATERAL (
    SELECT decision, reason_code, decided_at
    FROM report_release_decisions
    WHERE report_version_id = rv.id
    ORDER BY seq DESC
    LIMIT 1
) d ON true;
