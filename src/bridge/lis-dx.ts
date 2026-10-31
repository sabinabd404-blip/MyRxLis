/**
 * Bridge between MyRx LIS Lite and MyRx DX for a lab that runs both.
 *
 * Inbound:  the lab's DX work queue appears as an LIS inbox. Importing an
 *           item accepts it in DX and creates (or extends) an LIS order,
 *           matched to DX by the DX order id.
 * Outbound: when the LIS releases a report, every newly released test that
 *           came from DX is sent to DX as a report version, carrying the
 *           lab's distribution decision. When a held report is later
 *           authorised (the bill is paid), that decision is passed on too.
 *
 * Everything runs in the caller's transaction, so an LIS release and its DX
 * submission succeed or fail together.
 */
import type pg from 'pg';
import * as dx from '../dx/service.js';
import { badRequest, conflict, notFound } from '../lis/errors.js';
import type { AgeInput } from '../lis/clinical.js';
import * as lis from '../lis/service.js';

type Q = pg.PoolClient | pg.Pool;

export const IDENTITY_SEPARATOR = '|';

interface DxLink { labCode: string; organisationId: string; actor: dx.DxActor }

/** The lab's DX link, or null when the lab is not connected to DX. */
export async function dxLink(c: Q, labId: string): Promise<DxLink | null> {
  const { rows: [lab] } = await c.query(
    'SELECT code, dx_organisation_id, dx_service_user_id FROM lis.labs WHERE id = $1', [labId]);
  if (!lab?.dx_organisation_id) return null;
  const actor = await dx.getActor(c, lab.dx_service_user_id, lab.dx_organisation_id);
  if (!actor) throw conflict('The lab\'s DX service account is not an active member of its DX organisation');
  return { labCode: lab.code, organisationId: lab.dx_organisation_id, actor };
}

async function requireLink(c: Q, labId: string): Promise<DxLink> {
  const link = await dxLink(c, labId);
  if (!link) throw conflict('This lab is not connected to MyRx DX');
  return link;
}

/** DX work for this lab, with the LIS test it maps to (by MyRx test code). */
export async function inbox(c: Q, staff: lis.Staff) {
  const link = await requireLink(c, staff.lab_id);
  const queue = await dx.labWorkQueue(c, link.actor);
  const { rows: tests } = await c.query<{ id: string; myrx_test_code: string; name: string }>(
    'SELECT id, myrx_test_code, name FROM lis.tests WHERE lab_id = $1 AND active AND myrx_test_code IS NOT NULL', [staff.lab_id]);
  const byCode = new Map(tests.map((t) => [t.myrx_test_code, t]));
  const { rows: imported } = await c.query<{ dx_assignment_id: string }>(
    'SELECT dx_assignment_id FROM lis.order_tests WHERE lab_id = $1 AND dx_assignment_id IS NOT NULL', [staff.lab_id]);
  const done = new Set(imported.map((r) => r.dx_assignment_id));
  return queue
    .filter((item) => !done.has(item.assignment_id))
    .map((item) => ({ ...item, lis_test: byCode.get(item.canonical_code) ?? null }));
}

export interface ImportInput {
  assignment_ids: string[];
  /** An existing LIS patient, or details to register one. */
  patient_id?: string;
  patient?: lis.PatientInput;
  age?: AgeInput;
  referring_doctor_id?: string;
}

/**
 * Take DX items into the LIS: accept them in DX and create the LIS order
 * (or add to the one already created for the same DX order). The patient is
 * matched by their MyRx identity; staff confirm or register them at the desk.
 */
export async function importAssignments(c: pg.PoolClient, staff: lis.Staff, input: ImportInput) {
  lis.requireRole(staff, 'admin', 'receptionist');
  const link = await requireLink(c, staff.lab_id);
  const ids = [...new Set(input.assignment_ids)];
  if (ids.length === 0) throw badRequest('Choose at least one DX item to import');

  const { rows: items } = await c.query(
    `SELECT a.id, a.status, a.organisation_id, d.id AS dx_order_id, d.order_number, t.canonical_code,
            p.identity_system, p.identity_value
     FROM assignment_attempts a
     JOIN diagnostic_order_items i ON i.id = a.order_item_id
     JOIN diagnostic_orders d ON d.id = i.order_id
     JOIN catalogue_tests t ON t.id = i.catalogue_test_id
     JOIN patient_identity_refs p ON p.id = d.patient_identity_ref_id
     WHERE a.id = ANY($1::uuid[])`, [ids]);
  if (items.length !== ids.length || items.some((i) => i.organisation_id !== link.organisationId)) {
    throw notFound('One or more DX items');
  }
  const dxOrderIds = new Set(items.map((i) => i.dx_order_id));
  if (dxOrderIds.size !== 1) throw badRequest('Import items from one DX order at a time');
  const first = items[0]!;
  const dxOrderId = first.dx_order_id as string;
  const myrxRef = `${first.identity_system}${IDENTITY_SEPARATOR}${first.identity_value}`;

  // Map each DX investigation to this lab's LIS test.
  const { rows: tests } = await c.query<{ id: string; myrx_test_code: string }>(
    `SELECT id, myrx_test_code FROM lis.tests WHERE lab_id = $1 AND active AND myrx_test_code = ANY($2::text[])`,
    [staff.lab_id, items.map((i) => i.canonical_code)]);
  const testFor = new Map(tests.map((t) => [t.myrx_test_code, t.id]));
  const unmapped = items.filter((i) => !testFor.has(i.canonical_code)).map((i) => i.canonical_code);
  if (unmapped.length) throw badRequest(`No LIS test is mapped to: ${unmapped.join(', ')}`);

  // Accept in DX (already accepted is fine).
  for (const item of items) {
    if (item.status === 'offered') await dx.acceptAssignment(c, link.actor, item.id);
    else if (!['accepted', 'in_progress'].includes(item.status)) throw conflict(`DX item ${item.id} is ${item.status}`);
  }

  // Patient: match by MyRx identity, else use the one staff chose, else register.
  let patientId = input.patient_id ?? null;
  if (!patientId) {
    const { rows: [known] } = await c.query(
      'SELECT id FROM lis.patients WHERE lab_id = $1 AND myrx_patient_ref = $2 ORDER BY created_at LIMIT 1', [staff.lab_id, myrxRef]);
    patientId = known?.id ?? null;
  }
  if (!patientId) {
    if (!input.patient) throw badRequest('New patient: give their name and sex to register them');
    patientId = (await lis.registerPatient(c, staff, { ...input.patient, myrx_patient_ref: myrxRef })).id as string;
  } else {
    await c.query(
      `UPDATE lis.patients SET myrx_patient_ref = $3 WHERE id = $1 AND lab_id = $2 AND myrx_patient_ref IS NULL`,
      [patientId, staff.lab_id, myrxRef]);
  }

  // One LIS order per DX order: create it, or add these tests to it.
  const { rows: [existing] } = await c.query(
    `SELECT id FROM lis.orders WHERE lab_id = $1 AND source = 'myrx_dx' AND external_ref = $2`, [staff.lab_id, dxOrderId]);
  let orderId: string;
  if (!existing) {
    const order = await lis.createOrder(c, staff, {
      patient_id: patientId, referring_doctor_id: input.referring_doctor_id, age: input.age,
      test_ids: items.map((i) => testFor.get(i.canonical_code)!), source: 'myrx_dx', external_ref: dxOrderId,
      notes: `MyRx DX order ${first.order_number}`,
    });
    orderId = order.id;
  } else {
    orderId = existing.id;
    await addTestsToOrder(c, staff, orderId, items.map((i) => testFor.get(i.canonical_code)!));
  }

  for (const item of items) {
    const res = await c.query(
      `UPDATE lis.order_tests SET dx_assignment_id = $3
       WHERE order_id = $1 AND test_id = $2 AND dx_assignment_id IS NULL`,
      [orderId, testFor.get(item.canonical_code), item.id]);
    if (res.rowCount !== 1) throw conflict(`The ${item.canonical_code} test on this order is already linked to DX`);
  }
  return lis.getOrder(c, staff.lab_id, orderId);
}

async function addTestsToOrder(c: pg.PoolClient, staff: lis.Staff, orderId: string, testIds: string[]) {
  const { rows: tests } = await c.query<{ id: string; price: string; specimen_type: string | null }>(
    'SELECT id, price, specimen_type FROM lis.tests WHERE lab_id = $1 AND id = ANY($2::uuid[])', [staff.lab_id, testIds]);
  let added = 0;
  for (const t of tests) {
    let specimenId: string | null = null;
    if (t.specimen_type) {
      const { rows: [s] } = await c.query(
        `SELECT id FROM lis.specimens WHERE order_id = $1 AND specimen_type = $2 AND status IN ('pending', 'collected', 'received')
         ORDER BY barcode LIMIT 1`, [orderId, t.specimen_type]);
      specimenId = s?.id ?? null;
      if (!specimenId) {
        const period = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date()).replaceAll('-', '').slice(2);
        const { rows: [{ n }] } = await c.query('SELECT lis.next_number($1, $2, $3) AS n', [staff.lab_id, 'barcode', period]);
        const { rows: [ns] } = await c.query(
          `INSERT INTO lis.specimens (lab_id, order_id, barcode, specimen_type) VALUES ($1, $2, $3, $4) RETURNING id`,
          [staff.lab_id, orderId, `${period}${String(n).padStart(4, '0')}`, t.specimen_type]);
        specimenId = ns.id;
      }
    }
    await c.query(
      `INSERT INTO lis.order_tests (lab_id, order_id, test_id, price, specimen_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id, test_id) DO NOTHING`, [staff.lab_id, orderId, t.id, t.price, specimenId]);
    added += Number(t.price);
  }
  await c.query('UPDATE lis.invoices SET gross = gross + $2 WHERE order_id = $1', [orderId, added]);
}

const RELEASE_FOR = (status: string, reason: string | null) =>
  status === 'authorised' ? { decision: 'authorised' as const }
    : status === 'held'
      ? { decision: 'held' as const, reason_code: reason === lis.AWAITING_PAYMENT ? 'awaiting_payment' : 'pending_review' }
      : { decision: 'restricted' as const, reason_code: 'lab_policy', reason_text: reason ?? undefined };

/**
 * After an LIS release: send each newly released DX-linked test to DX as a
 * report version (final, or corrected if it was released before).
 */
export async function pushRelease(
  c: pg.PoolClient, labId: string,
  release: { id: string; order_id: string; distribution_status: string; distribution_reason: string | null;
    released_now: string[]; corrected: string[]; released_at: string },
): Promise<number> {
  const link = await dxLink(c, labId);
  if (!link) return 0;
  const { rows: linked } = await c.query<{ id: string; dx_assignment_id: string }>(
    `SELECT id, dx_assignment_id FROM lis.order_tests
     WHERE id = ANY($1::uuid[]) AND dx_assignment_id IS NOT NULL`, [release.released_now]);
  let sent = 0;
  for (const t of linked) {
    const test = await lis.getOrderTest(c, labId, t.id);
    const result = await dx.submitResults(c, link.actor, t.dx_assignment_id, {
      source_system: `myrx-lis:${link.labCode}`,
      idempotency_key: `lis-report-${release.id}-${t.id}`,
      status: release.corrected.includes(t.id) ? 'corrected' : 'final',
      result_at: new Date(release.released_at).toISOString(),
      source_result_set_id: release.id,
      observations: (test.results as { parameter_code: string; name: string; value: string | null; unit: string | null;
        ref_low: string | null; ref_high: string | null; ref_text: string | null; flag: string | null }[])
        .filter((r) => r.value !== null)
        .map((r) => ({
          code: r.parameter_code, name: r.name, value: r.value!, unit: r.unit ?? undefined, flag: r.flag ?? undefined,
          reference_range: r.ref_text ?? (r.ref_low !== null || r.ref_high !== null
            ? `${r.ref_low ?? ''}-${r.ref_high ?? ''}` : undefined),
        })),
      report: { storage_object_key: `lis/${link.labCode}/reports/${release.id}.pdf` },
      release: RELEASE_FOR(release.distribution_status, release.distribution_reason),
    });
    await c.query(
      `INSERT INTO lis.dx_submissions (lab_id, report_id, order_test_id, dx_report_version_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (report_id, order_test_id) DO NOTHING`,
      [labId, release.id, t.id, result.report_version_id]);
    sent++;
  }
  return sent;
}

/** Pass the LIS distribution status of an order's reports on to DX (e.g. authorised after payment). */
export async function syncReleaseDecisions(c: pg.PoolClient, labId: string, orderId: string): Promise<number> {
  const link = await dxLink(c, labId);
  if (!link) return 0;
  const { rows } = await c.query(
    `SELECT s.dx_report_version_id, r.distribution_status, r.distribution_reason, rs.decision AS dx_decision
     FROM lis.dx_submissions s
     JOIN lis.reports r ON r.id = s.report_id
     JOIN report_release_status rs ON rs.report_version_id = s.dx_report_version_id
     WHERE r.order_id = $1 AND s.lab_id = $2`, [orderId, labId]);
  let changed = 0;
  for (const r of rows) {
    const decision = RELEASE_FOR(r.distribution_status, r.distribution_reason);
    if (decision.decision !== r.dx_decision) {
      await dx.decideRelease(c, link.actor, r.dx_report_version_id, decision);
      changed++;
    }
  }
  return changed;
}

