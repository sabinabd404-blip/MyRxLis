-- ============================================================
-- MyRx DX — Migration 0007: support for the exchange API
--   * DX order numbers (DX-YYMMDD-NNNNNN) from a sequence
--   * index for the EMR result feed cursor
-- ============================================================

CREATE SEQUENCE dx_order_number_seq;

CREATE INDEX ix_release_decisions_seq ON report_release_decisions (seq);
CREATE INDEX ix_diagnostic_orders_ordering_org ON diagnostic_orders (ordering_organisation_id, placed_at DESC);
CREATE INDEX ix_diagnostic_orders_patient ON diagnostic_orders (patient_identity_ref_id);
