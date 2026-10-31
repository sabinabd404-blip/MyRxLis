-- ============================================================
-- MyRx DX — Migration 0004: assignment history protection
-- Closes the gaps the revised assignment lifecycle test (T3–T6) was
-- written to probe:
--   T3  an existing assignment cannot be redirected to another lab
--   T4  an attempt number cannot be rewritten
--   T5  assignment history cannot be deleted
--   T6  a closed attempt (completed, rejected, cancelled, expired)
--       cannot be reopened; reassignment is a new attempt
-- Status may still move forward on an open attempt, and response and
-- accession fields may still be filled in.
-- ============================================================

CREATE OR REPLACE FUNCTION dx_protect_assignment_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Assignment history cannot be deleted; cancel the attempt instead.'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.order_item_id        IS DISTINCT FROM OLD.order_item_id
    OR NEW.lab_service_offer_id IS DISTINCT FROM OLD.lab_service_offer_id
    OR NEW.organisation_id      IS DISTINCT FROM OLD.organisation_id
    OR NEW.branch_id            IS DISTINCT FROM OLD.branch_id
    OR NEW.attempt_number       IS DISTINCT FROM OLD.attempt_number
    OR NEW.offered_at           IS DISTINCT FROM OLD.offered_at THEN
        RAISE EXCEPTION 'Assignment % cannot be redirected or renumbered; create a new attempt.', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status IN ('completed', 'rejected', 'cancelled', 'expired')
       AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Assignment % is closed (%); create a new attempt instead.', OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT (
        NEW.status = OLD.status OR
        (OLD.status = 'offered'     AND NEW.status IN ('accepted', 'rejected', 'cancelled', 'expired')) OR
        (OLD.status = 'accepted'    AND NEW.status IN ('in_progress', 'completed', 'cancelled')) OR
        (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'Invalid assignment status change: % -> %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dx_assignment_history
    BEFORE UPDATE OR DELETE ON assignment_attempts
    FOR EACH ROW EXECUTE FUNCTION dx_protect_assignment_history();
