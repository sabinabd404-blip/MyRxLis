-- ============================================================
-- MyRx LIS — Migration 0006: per-lab running numbers
-- Order numbers, patient codes, barcodes and money receipt numbers
-- are issued from per-lab, per-day counters inside the same
-- transaction that uses them, so two counters never hand out the
-- same number.
-- ============================================================

CREATE TABLE lis.counters (
    lab_id   uuid NOT NULL REFERENCES lis.labs(id),
    name     text NOT NULL,
    period   text NOT NULL DEFAULT '',
    value    bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (lab_id, name, period)
);

CREATE FUNCTION lis.next_number(p_lab uuid, p_name text, p_period text DEFAULT '')
RETURNS bigint
LANGUAGE sql AS $$
    INSERT INTO lis.counters (lab_id, name, period, value)
    VALUES (p_lab, p_name, p_period, 1)
    ON CONFLICT (lab_id, name, period) DO UPDATE SET value = lis.counters.value + 1
    RETURNING value;
$$;
