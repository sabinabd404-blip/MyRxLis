/**
 * MyRx DX exchange workflows: the path from a doctor's order in MyRx EMR to
 * results back in the EMR.
 *
 *   EMR  ── submitOrder ──▶ DX ── assignItem ──▶ lab work queue
 *   lab  ── accept / reject, submitResults (+ release decision) ──▶ DX
 *   EMR  ◀── resultFeed (changes since a cursor) / orderStatus ── DX
 *
 * Every write runs inside one transaction. Access is always scoped: an EMR
 * client sees only orders placed by its own organisation, and a lab sees only
 * the items assigned to it. Denied lab access is written to audit_events.
 */
import type pg from 'pg';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lis/errors.js';

/**
 * A refusal that must be audited. The surrounding transaction is rolled back,
 * so the API layer writes the audit event separately after catching this.
 */
export class AuditedDenial extends HttpError {
  constructor(
    public readonly actor: DxActor, public readonly action: string,
    public readonly resourceType: string, public readonly resourceId: string, public readonly reason: string,
    what: string,
  ) {
    super(404, `${what} not found`);
  }
}

type Q = pg.PoolClient | pg.Pool;

export interface DxActor {
  userId: string;
  organisationId: string;
  roles: string[];
}

const EMR_ROLES = ['clinician', 'chamber_assistant', 'integration_service', 'org_admin'];
const LAB_ROLES = ['lab_operator', 'lab_manager', 'integration_service', 'org_admin'];

/** Resolve the caller's roles in one organisation; null when not an active member. */
export async function getActor(c: Q, userId: string, organisationId: string): Promise<DxActor | null> {
  const { rows } = await c.query<{ role_code: string }>(
    `SELECT m.role_code FROM organisation_memberships m
     JOIN users u ON u.id = m.user_id
     JOIN organisations o ON o.id = m.organisation_id
     WHERE m.user_id = $1 AND m.organisation_id = $2 AND m.status = 'active'
       AND u.status = 'active' AND o.status = 'active'`, [userId, organisationId]);
  if (rows.length === 0) return null;
  return { userId, organisationId, roles: rows.map((r) => r.role_code) };
}

function require(actor: DxActor, allowed: string[], what: string) {
  if (!actor.roles.some((r) => allowed.includes(r))) throw forbidden(`Your role cannot ${what}`);
}

export async function audit(
  c: Q, actor: DxActor | null, action: string, resourceType: string, resourceId: string,
  outcome: 'success' | 'denied' | 'failure', reason?: string, metadata: object = {},
) {
  await c.query(
    `INSERT INTO audit_events (actor_user_id, organisation_id, action_code, resource_type, resource_id, outcome, reason_code, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor?.userId ?? null, actor?.organisationId ?? null, action, resourceType, resourceId, outcome, reason ?? null, metadata]);
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

/** Labs that offer a test: what a doctor or patient chooses from. */
export async function findOffers(c: Q, canonicalCode: string) {
  const { rows } = await c.query(
    `SELECT lso.id AS offer_id, o.id AS organisation_id, o.display_name AS lab, b.id AS branch_id, b.name AS branch,
            b.address_text, lso.local_test_name, lso.price_amount, lso.currency_code, lso.estimated_turnaround_minutes
     FROM lab_service_offers lso
     JOIN catalogue_tests t ON t.id = lso.catalogue_test_id
     JOIN organisations o ON o.id = lso.organisation_id
     JOIN branches b ON b.id = lso.branch_id
     WHERE t.canonical_code = $1 AND lso.status = 'active' AND o.status = 'active' AND b.status = 'active'
     ORDER BY lso.price_amount NULLS LAST, o.display_name`, [canonicalCode]);
  return rows;
}

// ---------------------------------------------------------------------------
// Orders (EMR side)
// ---------------------------------------------------------------------------

export interface OrderSubmission {
  source_system: string;
  source_order_id: string;
  patient: { identity_system: string; identity_value: string };
  encounter?: { source_encounter_id: string; encounter_at?: string };
  ordering_practitioner_ref?: string;
  clinical_indication?: string;
  priority?: 'routine' | 'urgent' | 'stat';
  items: { canonical_code: string; clinical_notes?: string; lab_service_offer_id?: string }[];
}

/**
 * Register an order from the EMR. Idempotent: resubmitting the same
 * (source_system, source_order_id) returns the existing order unchanged.
 * Items may name a lab offer to assign straight away (e.g. the chamber's own
 * diagnostic centre); the rest wait for the patient to choose a lab.
 */
export async function submitOrder(c: pg.PoolClient, actor: DxActor, input: OrderSubmission) {
  require(actor, EMR_ROLES, 'place orders');
  if (input.items.length === 0) throw badRequest('An order needs at least one investigation');

  // Serialise concurrent resubmissions of the same order.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${input.source_system}|${input.source_order_id}`]);
  const { rows: [existing] } = await c.query(
    'SELECT id, ordering_organisation_id FROM diagnostic_orders WHERE source_system = $1 AND source_order_id = $2',
    [input.source_system, input.source_order_id]);
  if (existing) {
    if (existing.ordering_organisation_id !== actor.organisationId) throw conflict('Order reference already used by another organisation');
    return { created: false, order: await orderStatus(c, actor, existing.id) };
  }

  const { rows: [patient] } = await c.query(
    `INSERT INTO patient_identity_refs (identity_system, identity_value) VALUES ($1, $2)
     ON CONFLICT (identity_system, identity_value) DO UPDATE SET identity_value = EXCLUDED.identity_value
     RETURNING id`, [input.patient.identity_system, input.patient.identity_value]);

  let encounterId: string | null = null;
  if (input.encounter) {
    const { rows: [enc] } = await c.query(
      `INSERT INTO encounters (source_system, source_encounter_id, patient_identity_ref_id, practitioner_ref, encounter_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
       ON CONFLICT (source_system, source_encounter_id) DO UPDATE SET source_encounter_id = EXCLUDED.source_encounter_id
       RETURNING id, patient_identity_ref_id`,
      [input.source_system, input.encounter.source_encounter_id, patient.id, input.ordering_practitioner_ref ?? null,
        input.encounter.encounter_at ?? null]);
    if (enc.patient_identity_ref_id !== patient.id) throw conflict('Encounter belongs to a different patient');
    encounterId = enc.id;
  }

  const codes = [...new Set(input.items.map((i) => i.canonical_code))];
  const { rows: tests } = await c.query<{ id: string; canonical_code: string; display_name: string; specimen_type: string | null }>(
    `SELECT id, canonical_code, display_name, specimen_type FROM catalogue_tests
     WHERE status = 'active' AND canonical_code = ANY($1::text[])`, [codes]);
  const byCode = new Map(tests.map((t) => [t.canonical_code, t]));
  const unknown = codes.filter((code) => !byCode.has(code));
  if (unknown.length) throw badRequest(`Unknown investigation codes: ${unknown.join(', ')}`);

  const { rows: [{ n }] } = await c.query(`SELECT nextval('dx_order_number_seq') AS n`);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date()).replaceAll('-', '').slice(2);
  const orderNumber = `DX-${ymd}-${String(n).padStart(6, '0')}`;

  const { rows: [order] } = await c.query(
    `INSERT INTO diagnostic_orders (order_number, source_system, source_order_id, patient_identity_ref_id, encounter_id,
                                    ordering_organisation_id, ordering_practitioner_ref, clinical_indication, priority, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'submitted') RETURNING id`,
    [orderNumber, input.source_system, input.source_order_id, patient.id, encounterId, actor.organisationId,
      input.ordering_practitioner_ref ?? null, input.clinical_indication ?? null, input.priority ?? 'routine']);

  let line = 0;
  for (const item of input.items) {
    const t = byCode.get(item.canonical_code)!;
    const { rows: [row] } = await c.query(
      `INSERT INTO diagnostic_order_items (order_id, line_number, catalogue_test_id, requested_test_name,
                                          requested_specimen_type, clinical_notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [order.id, ++line, t.id, t.display_name, t.specimen_type, item.clinical_notes ?? null]);
    if (item.lab_service_offer_id) await assignToOffer(c, row.id, item.lab_service_offer_id);
  }
  await refreshOrderStatus(c, order.id);
  await audit(c, actor, 'order.submit', 'diagnostic_order', order.id, 'success');
  return { created: true, order: await orderStatus(c, actor, order.id) };
}

async function assignToOffer(c: pg.PoolClient, itemId: string, offerId: string) {
  const { rows: [offer] } = await c.query(
    `SELECT id, organisation_id, branch_id FROM lab_service_offers WHERE id = $1 AND status = 'active'`, [offerId]);
  if (!offer) throw badRequest('That lab offer is not available');
  const { rows: [{ next }] } = await c.query(
    'SELECT COALESCE(max(attempt_number), 0) + 1 AS next FROM assignment_attempts WHERE order_item_id = $1', [itemId]);
  await c.query('SAVEPOINT assign');
  try {
    await c.query(
      `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number, status)
       VALUES ($1, $2, $3, $4, $5, 'offered')`, [itemId, offer.id, offer.organisation_id, offer.branch_id, next]);
    await c.query('RELEASE SAVEPOINT assign');
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT assign');
    const code = (err as { code?: string }).code;
    if (code === '23505') throw conflict('This investigation is already with a lab; cancel that first');
    if (code === '23514') throw badRequest('That lab offer is for a different investigation');
    throw err;
  }
  await c.query(`UPDATE diagnostic_order_items SET status = 'assigned' WHERE id = $1 AND status IN ('ordered', 'rejected')`, [itemId]);
}

/** Send one waiting investigation to a chosen lab (e.g. near the patient's home). */
export async function assignItem(c: pg.PoolClient, actor: DxActor, orderId: string, itemId: string, offerId: string) {
  require(actor, EMR_ROLES, 'assign investigations');
  await ownOrder(c, actor, orderId);
  const { rows: [item] } = await c.query(
    'SELECT id, status FROM diagnostic_order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [itemId, orderId]);
  if (!item) throw notFound('Order item');
  if (['final', 'corrected', 'cancelled', 'entered_in_error'].includes(item.status)) {
    throw conflict(`This investigation is already ${item.status}`);
  }
  await assignToOffer(c, itemId, offerId);
  await refreshOrderStatus(c, orderId);
  await audit(c, actor, 'item.assign', 'diagnostic_order_item', itemId, 'success', undefined, { offer_id: offerId });
  return orderStatus(c, actor, orderId);
}

async function ownOrder(c: Q, actor: DxActor, orderId: string) {
  const { rows: [o] } = await c.query(
    'SELECT id FROM diagnostic_orders WHERE id = $1 AND ordering_organisation_id = $2', [orderId, actor.organisationId]);
  if (!o) throw notFound('Order');
}

async function refreshOrderStatus(c: Q, orderId: string) {
  await c.query(
    `UPDATE diagnostic_orders d SET status = s.status
     FROM (
       SELECT CASE
         WHEN bool_and(i.status IN ('final', 'corrected', 'cancelled', 'entered_in_error')) THEN 'completed'
         WHEN bool_or(i.status IN ('final', 'corrected', 'preliminary')) THEN 'partially_completed'
         WHEN bool_or(i.status IN ('accepted', 'specimen_collected', 'processing')) THEN 'in_progress'
         WHEN bool_and(i.status <> 'ordered') THEN 'assigned'
         WHEN bool_or(i.status <> 'ordered') THEN 'partially_assigned'
         ELSE 'submitted' END AS status
       FROM diagnostic_order_items i WHERE i.order_id = $1
     ) s
     WHERE d.id = $1 AND d.status NOT IN ('cancelled', 'entered_in_error') AND d.status <> s.status`, [orderId]);
}

/**
 * The consolidated view the EMR shows: every investigation, which lab has it,
 * and the latest authorised results. Unauthorised (held or restricted)
 * reports are reported as "awaiting release" without their content.
 */
export async function orderStatus(c: Q, actor: DxActor, orderId: string) {
  require(actor, EMR_ROLES, 'view orders');
  const { rows: [order] } = await c.query(
    `SELECT d.id, d.order_number, d.source_system, d.source_order_id, d.status, d.priority, d.placed_at,
            p.identity_system, p.identity_value
     FROM diagnostic_orders d JOIN patient_identity_refs p ON p.id = d.patient_identity_ref_id
     WHERE d.id = $1 AND d.ordering_organisation_id = $2`, [orderId, actor.organisationId]);
  if (!order) throw notFound('Order');
  const { rows: items } = await c.query(
    `SELECT i.id, i.line_number, t.canonical_code, i.requested_test_name, i.status,
            a.id AS assignment_id, a.status AS assignment_status, o.display_name AS lab, b.name AS branch,
            r.report_version_id, r.version_number, r.report_status, r.decision AS release_decision
     FROM diagnostic_order_items i
     JOIN catalogue_tests t ON t.id = i.catalogue_test_id
     LEFT JOIN LATERAL (
       SELECT * FROM assignment_attempts aa WHERE aa.order_item_id = i.id ORDER BY aa.attempt_number DESC LIMIT 1
     ) a ON true
     LEFT JOIN organisations o ON o.id = a.organisation_id
     LEFT JOIN branches b ON b.id = a.branch_id
     LEFT JOIN LATERAL (
       SELECT rv.id AS report_version_id, rv.version_number, rv.report_status, rs.decision
       FROM report_versions rv
       JOIN assignment_attempts aa ON aa.id = rv.assignment_attempt_id
       JOIN report_release_status rs ON rs.report_version_id = rv.id
       WHERE aa.order_item_id = i.id
       ORDER BY rv.created_at DESC, rv.version_number DESC LIMIT 1
     ) r ON true
     WHERE i.order_id = $1 ORDER BY i.line_number`, [orderId]);

  const withResults = [];
  for (const item of items) {
    const { report_version_id, release_decision, ...rest } = item;
    let results = null;
    if (report_version_id && release_decision === 'authorised') {
      results = await observationsFor(c, report_version_id);
    }
    withResults.push({
      ...rest,
      result_state: !report_version_id ? 'pending' : release_decision === 'authorised' ? 'available' : 'awaiting_release',
      results,
    });
  }
  return { ...order, items: withResults };
}

async function observationsFor(c: Q, reportVersionId: string) {
  const { rows } = await c.query(
    `SELECT o.observation_code AS code, o.observation_name AS name,
            COALESCE(o.value_numeric::text, o.value_text) AS value, o.unit_code AS unit,
            o.reference_range_text AS reference_range, o.abnormal_flag AS flag, o.observed_at
     FROM report_versions rv JOIN observation_results o ON o.result_set_id = rv.result_set_id
     WHERE rv.id = $1 ORDER BY o.created_at, o.observation_name`, [reportVersionId]);
  return rows;
}

// ---------------------------------------------------------------------------
// Labs
// ---------------------------------------------------------------------------

/** A lab's work queue: only items assigned to this lab, with the minimum needed to do the work. */
export async function labWorkQueue(c: Q, actor: DxActor, status?: string) {
  require(actor, LAB_ROLES, 'view the work queue');
  const statuses = status ? [status] : ['offered', 'accepted', 'in_progress'];
  const { rows } = await c.query(
    `SELECT a.id AS assignment_id, a.status, a.attempt_number, a.offered_at, a.external_accession_id,
            d.order_number, d.priority, d.clinical_indication, i.line_number, t.canonical_code,
            lso.local_test_code, lso.local_test_name, i.requested_specimen_type, i.clinical_notes,
            p.identity_system AS patient_identity_system, p.identity_value AS patient_identity_value,
            b.name AS branch
     FROM assignment_attempts a
     JOIN diagnostic_order_items i ON i.id = a.order_item_id
     JOIN diagnostic_orders d ON d.id = i.order_id
     JOIN catalogue_tests t ON t.id = i.catalogue_test_id
     JOIN lab_service_offers lso ON lso.id = a.lab_service_offer_id
     JOIN patient_identity_refs p ON p.id = d.patient_identity_ref_id
     JOIN branches b ON b.id = a.branch_id
     WHERE a.organisation_id = $1 AND a.status = ANY($2::text[])
     ORDER BY CASE d.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, a.offered_at`,
    [actor.organisationId, statuses]);
  return rows;
}

/** Load an assignment for this lab, auditing any attempt to reach another lab's work. */
async function labAssignment(c: Q, actor: DxActor, assignmentId: string, action: string) {
  const { rows: [a] } = await c.query(
    `SELECT a.id, a.status, a.organisation_id, a.order_item_id, i.order_id
     FROM assignment_attempts a JOIN diagnostic_order_items i ON i.id = a.order_item_id
     WHERE a.id = $1 FOR UPDATE OF a`, [assignmentId]);
  if (!a || a.organisation_id !== actor.organisationId) {
    // Same answer whether it exists or not, so IDs cannot be probed.
    throw new AuditedDenial(actor, action, 'assignment_attempt', assignmentId, 'not_assigned_to_lab', 'Assignment');
  }
  return a as { id: string; status: string; order_item_id: string; order_id: string };
}

export async function acceptAssignment(c: pg.PoolClient, actor: DxActor, assignmentId: string, accession?: string) {
  require(actor, LAB_ROLES, 'accept work');
  const a = await labAssignment(c, actor, assignmentId, 'assignment.accept');
  if (a.status !== 'offered') throw conflict(`Assignment is ${a.status}`);
  await c.query(
    `UPDATE assignment_attempts SET status = 'accepted', responded_at = now(), external_accession_id = $2 WHERE id = $1`,
    [a.id, accession ?? null]);
  await c.query(`UPDATE diagnostic_order_items SET status = 'accepted' WHERE id = $1`, [a.order_item_id]);
  await refreshOrderStatus(c, a.order_id);
  await audit(c, actor, 'assignment.accept', 'assignment_attempt', a.id, 'success');
  return { assignment_id: a.id, status: 'accepted' };
}

export async function rejectAssignment(c: pg.PoolClient, actor: DxActor, assignmentId: string, reason: string) {
  require(actor, LAB_ROLES, 'reject work');
  if (!reason?.trim()) throw badRequest('A reason is needed');
  const a = await labAssignment(c, actor, assignmentId, 'assignment.reject');
  if (a.status !== 'offered') throw conflict(`Assignment is ${a.status}`);
  await c.query(
    `UPDATE assignment_attempts SET status = 'rejected', rejection_reason = $2, responded_at = now(), closed_at = now()
     WHERE id = $1`, [a.id, reason.trim()]);
  // The investigation goes back to waiting for a lab.
  await c.query(`UPDATE diagnostic_order_items SET status = 'ordered' WHERE id = $1`, [a.order_item_id]);
  await refreshOrderStatus(c, a.order_id);
  await audit(c, actor, 'assignment.reject', 'assignment_attempt', a.id, 'success', 'rejected_by_lab');
  return { assignment_id: a.id, status: 'rejected' };
}

export interface ResultSubmission {
  source_system: string;
  idempotency_key: string;
  status: 'preliminary' | 'final' | 'corrected';
  result_at?: string;
  source_result_set_id?: string;
  observations: {
    code?: string; name: string; value: string | number; unit?: string;
    reference_range?: string; flag?: string; observed_at?: string;
  }[];
  report: { storage_object_key: string; media_type?: string; checksum_sha256?: string };
  /** The lab's distribution decision for this report. Defaults to authorised. */
  release?: { decision: 'held' | 'authorised' | 'restricted'; reason_code?: string; reason_text?: string };
}

/**
 * Receive results and the authorised report for one assignment. Idempotent
 * on (source_system, idempotency_key): a retried message returns the first
 * outcome. Each submission is a new report version that supersedes the last.
 */
export async function submitResults(c: pg.PoolClient, actor: DxActor, assignmentId: string, input: ResultSubmission) {
  require(actor, LAB_ROLES, 'submit results');
  const a = await labAssignment(c, actor, assignmentId, 'results.submit');

  const { rows: [dup] } = await c.query(
    `SELECT rs.id, rs.assignment_attempt_id, rv.id AS report_version_id, rv.version_number
     FROM result_sets rs LEFT JOIN report_versions rv ON rv.result_set_id = rs.id
     WHERE rs.source_system = $1 AND rs.idempotency_key = $2`, [input.source_system, input.idempotency_key]);
  if (dup) {
    if (dup.assignment_attempt_id !== a.id) throw conflict('That message key was already used for different work');
    return { duplicate: true, result_set_id: dup.id, report_version_id: dup.report_version_id, version: dup.version_number };
  }

  if (!['accepted', 'in_progress', 'completed'].includes(a.status)) {
    throw conflict(`Results cannot be submitted while the assignment is ${a.status}`);
  }
  if (input.observations.length === 0) throw badRequest('At least one observation is needed');

  const { rows: [rs] } = await c.query(
    `INSERT INTO result_sets (assignment_attempt_id, source_result_set_id, status, result_at, released_at, source_system, idempotency_key)
     VALUES ($1, $2, $3, $4, now(), $5, $6) RETURNING id`,
    [a.id, input.source_result_set_id ?? null, input.status, input.result_at ?? null, input.source_system, input.idempotency_key]);

  for (const o of input.observations) {
    const numeric = typeof o.value === 'number' ? o.value : /^-?\d+(\.\d+)?$/.test(String(o.value).trim()) ? Number(o.value) : null;
    await c.query(
      `INSERT INTO observation_results (result_set_id, order_item_id, observation_code, observation_name,
                                        value_text, value_numeric, unit_code, reference_range_text, abnormal_flag, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [rs.id, a.order_item_id, o.code ?? null, o.name, numeric === null ? String(o.value) : null, numeric,
        o.unit ?? null, o.reference_range ?? null, o.flag ?? null, o.observed_at ?? null]);
  }

  const { rows: [prev] } = await c.query(
    `SELECT id, version_number FROM report_versions WHERE assignment_attempt_id = $1 ORDER BY version_number DESC LIMIT 1`,
    [a.id]);
  const { rows: [rv] } = await c.query(
    `INSERT INTO report_versions (assignment_attempt_id, result_set_id, version_number, report_status, storage_object_key,
                                  media_type, checksum_sha256, issued_at, supersedes_report_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8) RETURNING id, version_number`,
    [a.id, rs.id, (prev?.version_number ?? 0) + 1, input.status, input.report.storage_object_key,
      input.report.media_type ?? 'application/pdf', input.report.checksum_sha256 ?? null, prev?.id ?? null]);

  const release = input.release ?? { decision: 'authorised' as const };
  await recordDecision(c, actor, rv.id, release);

  if (a.status !== 'completed') {
    if (input.status === 'preliminary') {
      if (a.status === 'accepted') await c.query(`UPDATE assignment_attempts SET status = 'in_progress' WHERE id = $1`, [a.id]);
    } else {
      await c.query(`UPDATE assignment_attempts SET status = 'completed', closed_at = now() WHERE id = $1`, [a.id]);
    }
  }
  await c.query('UPDATE diagnostic_order_items SET status = $2 WHERE id = $1', [a.order_item_id, input.status]);
  await refreshOrderStatus(c, a.order_id);
  await audit(c, actor, 'results.submit', 'report_version', rv.id, 'success', undefined, { version: rv.version_number });
  return { duplicate: false, result_set_id: rs.id, report_version_id: rv.id, version: rv.version_number };
}

async function recordDecision(
  c: Q, actor: DxActor, reportVersionId: string,
  d: { decision: string; reason_code?: string; reason_text?: string },
) {
  if (d.decision !== 'authorised' && !d.reason_code) throw badRequest('Holding or restricting a report needs a reason_code');
  await c.query(
    `INSERT INTO report_release_decisions (report_version_id, decision, reason_code, reason_text, decided_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [reportVersionId, d.decision, d.reason_code ?? null, d.reason_text ?? null, actor.userId]);
}

/** The lab changes who may receive a report, e.g. authorising it once the bill is paid. */
export async function decideRelease(
  c: pg.PoolClient, actor: DxActor, reportVersionId: string,
  d: { decision: 'held' | 'authorised' | 'restricted'; reason_code?: string; reason_text?: string },
) {
  require(actor, LAB_ROLES, 'release reports');
  const { rows: [rv] } = await c.query(
    `SELECT rv.id FROM report_versions rv JOIN assignment_attempts a ON a.id = rv.assignment_attempt_id
     WHERE rv.id = $1 AND a.organisation_id = $2`, [reportVersionId, actor.organisationId]);
  if (!rv) throw new AuditedDenial(actor, 'report.release', 'report_version', reportVersionId, 'not_lab_report', 'Report');
  await recordDecision(c, actor, reportVersionId, d);
  await audit(c, actor, 'report.release', 'report_version', reportVersionId, 'success', d.reason_code, { decision: d.decision });
  return { report_version_id: reportVersionId, decision: d.decision };
}

// ---------------------------------------------------------------------------
// EMR result feed
// ---------------------------------------------------------------------------

/**
 * Everything that changed for this EMR's orders since `cursor`, oldest first.
 * Each entry is a release decision on a report version:
 *   - "available": the lab authorised it; results are included.
 *   - "withdrawn": the lab held or restricted a report it had authorised; the EMR should hide it.
 * Store `next_cursor` and pass it on the next call. A version that supersedes
 * an earlier one says so, so the EMR can replace the old values.
 */
export async function resultFeed(c: Q, actor: DxActor, cursor: number, limit = 100) {
  require(actor, EMR_ROLES, 'read results');
  const { rows } = await c.query(
    `SELECT d.seq, d.decision, d.decided_at, rv.id AS report_version_id, rv.version_number, rv.report_status,
            rv.supersedes_report_version_id, rv.storage_object_key, rv.media_type,
            o.id AS order_id, o.order_number, o.source_system, o.source_order_id,
            i.id AS order_item_id, i.line_number, t.canonical_code, i.requested_test_name,
            p.identity_system, p.identity_value, org.display_name AS lab,
            EXISTS (SELECT 1 FROM report_release_decisions e
                    WHERE e.report_version_id = rv.id AND e.seq < d.seq AND e.decision = 'authorised') AS was_authorised
     FROM report_release_decisions d
     JOIN report_versions rv ON rv.id = d.report_version_id
     JOIN assignment_attempts a ON a.id = rv.assignment_attempt_id
     JOIN diagnostic_order_items i ON i.id = a.order_item_id
     JOIN diagnostic_orders o ON o.id = i.order_id
     JOIN catalogue_tests t ON t.id = i.catalogue_test_id
     JOIN patient_identity_refs p ON p.id = o.patient_identity_ref_id
     JOIN organisations org ON org.id = a.organisation_id
     WHERE o.ordering_organisation_id = $1 AND d.seq > $2
     ORDER BY d.seq
     LIMIT $3`, [actor.organisationId, cursor, limit]);

  const entries = [];
  for (const r of rows) {
    const { seq, decision, was_authorised, ...rest } = r;
    if (decision === 'authorised') {
      entries.push({ event: 'available', ...rest, results: await observationsFor(c, r.report_version_id) });
    } else if (was_authorised) {
      entries.push({ event: 'withdrawn', ...rest, results: null });
    }
    // A hold on a report that was never authorised is invisible to the EMR.
  }
  const nextCursor = rows.length ? Number(rows[rows.length - 1].seq) : cursor;
  return { entries, next_cursor: nextCursor, has_more: rows.length === limit };
}

/** All currently available results for one patient across this EMR's orders, newest first. */
export async function patientResults(c: Q, actor: DxActor, identitySystem: string, identityValue: string) {
  require(actor, EMR_ROLES, 'read results');
  const { rows } = await c.query(
    `SELECT DISTINCT ON (i.id) rv.id AS report_version_id, rv.version_number, rv.report_status, rv.issued_at,
            o.order_number, o.source_order_id, i.id AS order_item_id, t.canonical_code, i.requested_test_name,
            org.display_name AS lab, s.decision
     FROM patient_identity_refs p
     JOIN diagnostic_orders o ON o.patient_identity_ref_id = p.id AND o.ordering_organisation_id = $3
     JOIN diagnostic_order_items i ON i.order_id = o.id
     JOIN catalogue_tests t ON t.id = i.catalogue_test_id
     JOIN assignment_attempts a ON a.order_item_id = i.id
     JOIN report_versions rv ON rv.assignment_attempt_id = a.id
     JOIN report_release_status s ON s.report_version_id = rv.id
     JOIN organisations org ON org.id = a.organisation_id
     WHERE p.identity_system = $1 AND p.identity_value = $2
     ORDER BY i.id, rv.created_at DESC, rv.version_number DESC`,
    [identitySystem, identityValue, actor.organisationId]);
  const out = [];
  for (const r of rows.filter((x) => x.decision === 'authorised')) {
    const { decision, ...rest } = r;
    out.push({ ...rest, results: await observationsFor(c, r.report_version_id) });
  }
  out.sort((x, y) => new Date(y.issued_at).getTime() - new Date(x.issued_at).getTime());
  return out;
}
