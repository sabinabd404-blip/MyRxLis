/**
 * LIS Lite workflows: registration, ordering, billing, specimens, results,
 * validation and report release. Every write function expects to run inside
 * one transaction (see withTransaction in ../db.ts) so a failure leaves no
 * partial order, payment or report behind.
 */
import type pg from 'pg';
import {
  ageFromDateOfBirth, ageToDays, dhakaPeriod, flagNumeric, formatAge, pickRange,
  type AgeInput, type RangeRow,
} from './clinical.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

type Q = pg.PoolClient | pg.Pool;

export type Role = 'admin' | 'receptionist' | 'technologist' | 'pathologist';

export interface Staff {
  id: string;
  lab_id: string;
  full_name: string;
  role: Role;
}

export function requireRole(staff: Staff, ...roles: Role[]): void {
  if (!roles.includes(staff.role)) {
    throw forbidden(`This action needs one of these roles: ${roles.join(', ')}`);
  }
}

async function nextNumber(c: Q, labId: string, name: string, period = ''): Promise<number> {
  const { rows } = await c.query<{ n: string }>('SELECT lis.next_number($1, $2, $3) AS n', [labId, name, period]);
  return Number(rows[0]!.n);
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export async function getStaff(c: Q, labId: string, staffId: string): Promise<Staff | null> {
  const { rows } = await c.query<Staff>(
    `SELECT id, lab_id, full_name, role FROM lis.staff_users WHERE id = $1 AND lab_id = $2 AND active`,
    [staffId, labId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export interface PatientInput {
  full_name: string;
  full_name_bn?: string;
  sex: 'male' | 'female' | 'other' | 'unknown';
  date_of_birth?: string;
  phone?: string;
  address?: string;
  myrx_patient_ref?: string;
}

export async function registerPatient(c: Q, staff: Staff, input: PatientInput) {
  requireRole(staff, 'admin', 'receptionist');
  const code = `P-${pad(await nextNumber(c, staff.lab_id, 'patient'), 6)}`;
  const { rows } = await c.query(
    `INSERT INTO lis.patients (lab_id, patient_code, full_name, full_name_bn, sex, date_of_birth, phone, address, myrx_patient_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [staff.lab_id, code, input.full_name, input.full_name_bn ?? null, input.sex, input.date_of_birth ?? null,
      input.phone ?? null, input.address ?? null, input.myrx_patient_ref ?? null]);
  return rows[0];
}

export async function searchPatients(c: Q, labId: string, q: string) {
  const term = q.trim();
  if (term.length < 2) throw badRequest('Search needs at least 2 characters');
  const { rows } = await c.query(
    `SELECT * FROM lis.patients
     WHERE lab_id = $1 AND (patient_code = $2 OR phone LIKE '%' || $2 || '%' OR lower(full_name) LIKE '%' || lower($2) || '%')
     ORDER BY created_at DESC LIMIT 50`, [labId, term]);
  return rows;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export async function listTests(c: Q, labId: string) {
  const { rows } = await c.query(
    `SELECT t.id, t.code, t.name, t.short_name, t.specimen_type, t.price, t.myrx_test_code, d.name AS department,
            COALESCE(json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.name, 'unit', p.unit,
                     'result_type', p.result_type, 'options', p.options) ORDER BY p.sort_order)
                     FILTER (WHERE p.id IS NOT NULL), '[]') AS parameters
     FROM lis.tests t
     LEFT JOIN lis.departments d ON d.id = t.department_id
     LEFT JOIN lis.test_parameters p ON p.test_id = t.id
     WHERE t.lab_id = $1 AND t.active
     GROUP BY t.id, d.name
     ORDER BY t.sort_order, t.name`, [labId]);
  return rows;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderInput {
  patient_id: string;
  referring_doctor_id?: string;
  /** Age as written on the requisition; if omitted, the patient's date of birth is used. */
  age?: AgeInput;
  test_ids: string[];
  discount?: number;
  notes?: string;
  source?: 'walk_in' | 'myrx_dx';
  external_ref?: string;
}

export async function createOrder(c: pg.PoolClient, staff: Staff, input: OrderInput) {
  requireRole(staff, 'admin', 'receptionist');
  const labId = staff.lab_id;
  const testIds = [...new Set(input.test_ids)];
  if (testIds.length === 0) throw badRequest('An order needs at least one test');

  const { rows: [patient] } = await c.query(
    'SELECT id, date_of_birth FROM lis.patients WHERE id = $1 AND lab_id = $2', [input.patient_id, labId]);
  if (!patient) throw notFound('Patient');

  let ageDays: number;
  try {
    if (input.age) ageDays = ageToDays(input.age);
    else if (patient.date_of_birth) ageDays = ageFromDateOfBirth(new Date(patient.date_of_birth));
    else throw badRequest('Give the patient\'s age or record a date of birth');
  } catch (err) {
    if (err instanceof RangeError) throw badRequest(err.message);
    throw err;
  }

  const { rows: tests } = await c.query<{ id: string; price: string; specimen_type: string | null }>(
    'SELECT id, price, specimen_type FROM lis.tests WHERE lab_id = $1 AND active AND id = ANY($2::uuid[])',
    [labId, testIds]);
  if (tests.length !== testIds.length) throw badRequest('One or more tests are unknown or inactive at this lab');

  const { rows: [lab] } = await c.query('SELECT billing_enabled FROM lis.labs WHERE id = $1', [labId]);

  const period = dhakaPeriod();
  const orderNumber = `${period}-${pad(await nextNumber(c, labId, 'order', period), 4)}`;
  const { rows: [order] } = await c.query(
    `INSERT INTO lis.orders (lab_id, order_number, patient_id, referring_doctor_id, patient_age_days, source,
                             external_ref, ordered_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [labId, orderNumber, patient.id, input.referring_doctor_id ?? null, ageDays, input.source ?? 'walk_in',
      input.external_ref ?? null, staff.id, input.notes ?? null]);

  // One specimen (and barcode) per specimen type; tests without a specimen type get none.
  const specimenByType = new Map<string, string>();
  for (const type of new Set(tests.map((t) => t.specimen_type).filter((t): t is string => !!t))) {
    const barcode = `${period}${pad(await nextNumber(c, labId, 'barcode', period), 4)}`;
    const { rows: [s] } = await c.query(
      `INSERT INTO lis.specimens (lab_id, order_id, barcode, specimen_type) VALUES ($1, $2, $3, $4) RETURNING id`,
      [labId, order.id, barcode, type]);
    specimenByType.set(type, s.id);
  }

  let gross = 0;
  for (const t of tests) {
    gross += Number(t.price);
    await c.query(
      `INSERT INTO lis.order_tests (lab_id, order_id, test_id, price, specimen_id) VALUES ($1, $2, $3, $4, $5)`,
      [labId, order.id, t.id, t.price, t.specimen_type ? specimenByType.get(t.specimen_type) : null]);
  }

  if (lab.billing_enabled) {
    const discount = input.discount ?? 0;
    if (discount < 0 || discount > gross) throw badRequest('Discount must be between 0 and the total');
    await c.query('INSERT INTO lis.invoices (lab_id, order_id, gross, discount) VALUES ($1, $2, $3, $4)',
      [labId, order.id, gross, discount]);
  } else if (input.discount) {
    throw badRequest('Billing is switched off for this lab');
  }

  return getOrder(c, labId, order.id);
}

export async function getOrder(c: Q, labId: string, orderId: string) {
  const { rows: [order] } = await c.query(
    `SELECT o.id, o.order_number, o.ordered_at, o.patient_age_days, o.source, o.external_ref, o.notes,
            json_build_object('id', p.id, 'patient_code', p.patient_code, 'full_name', p.full_name,
                              'sex', p.sex, 'phone', p.phone) AS patient,
            CASE WHEN d.id IS NULL THEN NULL ELSE json_build_object('id', d.id, 'name', d.name) END AS referring_doctor
     FROM lis.orders o
     JOIN lis.patients p ON p.id = o.patient_id
     LEFT JOIN lis.referring_doctors d ON d.id = o.referring_doctor_id
     WHERE o.id = $1 AND o.lab_id = $2`, [orderId, labId]);
  if (!order) throw notFound('Order');

  const { rows: tests } = await c.query(
    `SELECT ot.id, ot.status, ot.price, ot.cancelled_reason, t.id AS test_id, t.code, t.name,
            s.id AS specimen_id, s.barcode, s.specimen_type, s.status AS specimen_status
     FROM lis.order_tests ot
     JOIN lis.tests t ON t.id = ot.test_id
     LEFT JOIN lis.specimens s ON s.id = ot.specimen_id
     WHERE ot.order_id = $1 ORDER BY t.sort_order, t.name`, [orderId]);
  const { rows: [invoice] } = await c.query(
    `SELECT i.id, i.gross, i.discount, i.net, b.paid, b.due
     FROM lis.invoices i JOIN lis.invoice_balances b ON b.invoice_id = i.id WHERE i.order_id = $1`, [orderId]);
  const { rows: reports } = await c.query(
    `SELECT id, version, clinical_status, distribution_status, distribution_reason, released_at
     FROM lis.reports WHERE order_id = $1 ORDER BY version`, [orderId]);

  return { ...order, age: formatAge(order.patient_age_days), tests, invoice: invoice ?? null, reports };
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export interface PaymentInput {
  amount: number;
  method: 'cash' | 'card' | 'bkash' | 'nagad' | 'rocket' | 'bank' | 'other';
  kind?: 'payment' | 'refund';
}

export async function recordPayment(c: pg.PoolClient, staff: Staff, orderId: string, input: PaymentInput) {
  requireRole(staff, 'admin', 'receptionist');
  // Lock the invoice so two counters cannot over-collect at the same moment.
  const { rows: [inv] } = await c.query(
    `SELECT i.id FROM lis.invoices i WHERE i.order_id = $1 AND i.lab_id = $2 FOR UPDATE`, [orderId, staff.lab_id]);
  if (!inv) throw notFound('Invoice for this order');
  const { rows: [bal] } = await c.query('SELECT paid, due FROM lis.invoice_balances WHERE invoice_id = $1', [inv.id]);
  const kind = input.kind ?? 'payment';
  if (!(input.amount > 0)) throw badRequest('Amount must be more than zero');
  if (kind === 'payment' && input.amount > Number(bal.due)) {
    throw conflict(`Payment of ${input.amount} is more than the amount due (${bal.due})`);
  }
  if (kind === 'refund' && input.amount > Number(bal.paid)) {
    throw conflict(`Refund of ${input.amount} is more than the amount paid (${bal.paid})`);
  }

  const period = dhakaPeriod();
  const receipt = `MR-${period}-${pad(await nextNumber(c, staff.lab_id, 'receipt', period), 4)}`;
  const { rows: [payment] } = await c.query(
    `INSERT INTO lis.payments (lab_id, invoice_id, kind, amount, method, receipt_number, received_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [staff.lab_id, inv.id, kind, input.amount, input.method, receipt, staff.id]);

  const { rows: [after] } = await c.query('SELECT paid, due FROM lis.invoice_balances WHERE invoice_id = $1', [inv.id]);
  let authorised = 0;
  if (Number(after.due) <= 0) {
    // Reports held only because of payment become available once the bill is settled.
    const res = await c.query(
      `UPDATE lis.reports SET distribution_status = 'authorised', distribution_reason = NULL
       WHERE order_id = $1 AND distribution_status = 'held' AND distribution_reason = $2`,
      [orderId, AWAITING_PAYMENT]);
    authorised = res.rowCount ?? 0;
  }
  return { payment, balance: after, reports_authorised: authorised };
}

export const AWAITING_PAYMENT = 'Awaiting payment';

// ---------------------------------------------------------------------------
// Specimens
// ---------------------------------------------------------------------------

export async function collectSpecimen(c: pg.PoolClient, staff: Staff, specimenId: string) {
  requireRole(staff, 'admin', 'receptionist', 'technologist');
  const { rows: [s] } = await c.query(
    `UPDATE lis.specimens SET status = 'collected', collected_at = now(), collected_by = $3
     WHERE id = $1 AND lab_id = $2 AND status = 'pending' RETURNING *`, [specimenId, staff.lab_id, staff.id]);
  if (!s) throw await specimenProblem(c, staff.lab_id, specimenId, 'collected');
  await c.query(`UPDATE lis.order_tests SET status = 'collected' WHERE specimen_id = $1 AND status = 'ordered'`, [specimenId]);
  return s;
}

export async function receiveSpecimen(c: pg.PoolClient, staff: Staff, specimenId: string) {
  requireRole(staff, 'admin', 'technologist', 'pathologist');
  const { rows: [s] } = await c.query(
    `UPDATE lis.specimens SET status = 'received', received_at = now(), received_by = $3
     WHERE id = $1 AND lab_id = $2 AND status = 'collected' RETURNING *`, [specimenId, staff.lab_id, staff.id]);
  if (!s) throw await specimenProblem(c, staff.lab_id, specimenId, 'received');
  return s;
}

async function specimenProblem(c: Q, labId: string, specimenId: string, action: string) {
  const { rows: [s] } = await c.query('SELECT status FROM lis.specimens WHERE id = $1 AND lab_id = $2', [specimenId, labId]);
  return s ? conflict(`Specimen cannot be ${action} while it is ${s.status}`) : notFound('Specimen');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ResultValue {
  parameter_code: string;
  value: string | number;
}

export async function enterResults(c: pg.PoolClient, staff: Staff, orderTestId: string, values: ResultValue[]) {
  requireRole(staff, 'technologist', 'pathologist');
  const { rows: [ot] } = await c.query(
    `SELECT ot.id, ot.status, ot.test_id, o.patient_age_days, p.sex
     FROM lis.order_tests ot
     JOIN lis.orders o ON o.id = ot.order_id
     JOIN lis.patients p ON p.id = o.patient_id
     WHERE ot.id = $1 AND ot.lab_id = $2 FOR UPDATE OF ot`, [orderTestId, staff.lab_id]);
  if (!ot) throw notFound('Ordered test');
  if (!['ordered', 'collected', 'in_progress', 'resulted'].includes(ot.status)) {
    throw conflict(`Results cannot be entered while the test is ${ot.status}`);
  }
  if (ot.status === 'ordered' || ot.status === 'collected') {
    if (ot.status === 'ordered') {
      const { rows: [s] } = await c.query(
        'SELECT 1 FROM lis.order_tests WHERE id = $1 AND specimen_id IS NOT NULL', [orderTestId]);
      if (s) throw conflict('Collect the specimen before entering results');
    }
    await c.query(`UPDATE lis.order_tests SET status = 'in_progress' WHERE id = $1`, [orderTestId]);
  }

  const { rows: params } = await c.query<{
    id: string; code: string; result_type: string; unit: string | null; decimals: number | null; options: string[] | null;
  }>('SELECT id, code, result_type, unit, decimals, options FROM lis.test_parameters WHERE test_id = $1', [ot.test_id]);
  const byCode = new Map(params.map((p) => [p.code, p]));

  for (const v of values) {
    const p = byCode.get(v.parameter_code);
    if (!p) throw badRequest(`Unknown parameter ${v.parameter_code} for this test`);
    const { rows: ranges } = await c.query<RangeRow>(
      `SELECT sex, age_min_days, age_max_days, low::float8 AS low, high::float8 AS high,
              critical_low::float8 AS critical_low, critical_high::float8 AS critical_high, range_text
       FROM lis.reference_ranges WHERE parameter_id = $1`, [p.id]);
    const range = pickRange(ranges, ot.sex, ot.patient_age_days);

    let numeric: number | null = null;
    let text: string | null = null;
    let flag: string | null = null;
    if (p.result_type === 'numeric') {
      numeric = typeof v.value === 'number' ? v.value : Number(String(v.value).trim());
      if (!Number.isFinite(numeric)) throw badRequest(`${p.code} needs a number`);
      flag = flagNumeric(numeric, range);
    } else {
      text = String(v.value).trim();
      if (!text) throw badRequest(`${p.code} needs a value`);
      if (p.result_type === 'option' && !p.options?.includes(text)) {
        throw badRequest(`${p.code} must be one of: ${p.options?.join(', ')}`);
      }
    }

    await c.query(
      `INSERT INTO lis.results (order_test_id, test_id, parameter_id, value_numeric, value_text, unit,
                                ref_low, ref_high, ref_text, flag, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (order_test_id, parameter_id) DO UPDATE SET
         value_numeric = EXCLUDED.value_numeric, value_text = EXCLUDED.value_text, unit = EXCLUDED.unit,
         ref_low = EXCLUDED.ref_low, ref_high = EXCLUDED.ref_high, ref_text = EXCLUDED.ref_text,
         flag = EXCLUDED.flag, entered_by = EXCLUDED.entered_by`,
      [orderTestId, ot.test_id, p.id, numeric, text, p.unit, range?.low ?? null, range?.high ?? null,
        range?.range_text ?? null, flag, staff.id]);
  }

  // The test is "resulted" once every parameter has a value.
  const { rows: [count] } = await c.query(
    `SELECT count(*)::int AS missing FROM lis.test_parameters p
     WHERE p.test_id = $1 AND NOT EXISTS (SELECT 1 FROM lis.results r WHERE r.order_test_id = $2 AND r.parameter_id = p.id)`,
    [ot.test_id, orderTestId]);
  const target = count.missing === 0 ? 'resulted' : 'in_progress';
  await c.query('UPDATE lis.order_tests SET status = $2 WHERE id = $1 AND status <> $2', [orderTestId, target]);
  return getOrderTest(c, staff.lab_id, orderTestId);
}

export async function getOrderTest(c: Q, labId: string, orderTestId: string) {
  const { rows: [ot] } = await c.query(
    `SELECT ot.id, ot.order_id, ot.status, t.code, t.name,
            COALESCE(json_agg(json_build_object('parameter_code', p.code, 'name', p.name,
                     'value', COALESCE(r.value_numeric::text, r.value_text), 'unit', r.unit,
                     'ref_low', r.ref_low, 'ref_high', r.ref_high, 'ref_text', r.ref_text, 'flag', r.flag)
                     ORDER BY p.sort_order) FILTER (WHERE p.id IS NOT NULL), '[]') AS results
     FROM lis.order_tests ot
     JOIN lis.tests t ON t.id = ot.test_id
     LEFT JOIN lis.test_parameters p ON p.test_id = t.id
     LEFT JOIN lis.results r ON r.order_test_id = ot.id AND r.parameter_id = p.id
     WHERE ot.id = $1 AND ot.lab_id = $2
     GROUP BY ot.id, t.code, t.name`, [orderTestId, labId]);
  if (!ot) throw notFound('Ordered test');
  return ot;
}

async function setTestStatus(c: Q, staff: Staff, orderTestId: string, from: string[], to: string, verb: string) {
  const { rows: [ot] } = await c.query(
    'SELECT status FROM lis.order_tests WHERE id = $1 AND lab_id = $2 FOR UPDATE', [orderTestId, staff.lab_id]);
  if (!ot) throw notFound('Ordered test');
  if (!from.includes(ot.status)) throw conflict(`A test that is ${ot.status} cannot be ${verb}`);
  await c.query('UPDATE lis.order_tests SET status = $2 WHERE id = $1', [orderTestId, to]);
  return getOrderTest(c, staff.lab_id, orderTestId);
}

export async function validateTest(c: pg.PoolClient, staff: Staff, orderTestId: string) {
  requireRole(staff, 'pathologist');
  return setTestStatus(c, staff, orderTestId, ['resulted'], 'validated', 'validated');
}

/** Reopen a validated or released test for correction; a released one will need an amended report. */
export async function reopenTest(c: pg.PoolClient, staff: Staff, orderTestId: string) {
  requireRole(staff, 'pathologist');
  return setTestStatus(c, staff, orderTestId, ['validated', 'released'], 'resulted', 'reopened');
}

export async function cancelTest(c: pg.PoolClient, staff: Staff, orderTestId: string, reason: string) {
  requireRole(staff, 'admin', 'receptionist', 'pathologist');
  if (!reason?.trim()) throw badRequest('A reason is needed to cancel a test');
  const { rows: [ot] } = await c.query(
    'SELECT status FROM lis.order_tests WHERE id = $1 AND lab_id = $2 FOR UPDATE', [orderTestId, staff.lab_id]);
  if (!ot) throw notFound('Ordered test');
  if (!['ordered', 'collected', 'in_progress'].includes(ot.status)) {
    throw conflict(`A test that is ${ot.status} cannot be cancelled`);
  }
  await c.query(`UPDATE lis.order_tests SET status = 'cancelled', cancelled_reason = $2 WHERE id = $1`,
    [orderTestId, reason.trim()]);
  return getOrderTest(c, staff.lab_id, orderTestId);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Release a report for an order. The report covers every released test plus
 * every test validated now; a later release creates a new version that
 * supersedes the previous one. Reopened (corrected) tests make the new
 * version "amended" and need a reason.
 *
 * Distribution follows the lab's policy: if the lab holds reports until paid
 * and money is due, the report is released clinically but held from
 * distribution with reason "Awaiting payment" until the bill is settled.
 */
export async function releaseReport(
  c: pg.PoolClient, staff: Staff, orderId: string, opts: { amendment_reason?: string } = {},
) {
  requireRole(staff, 'pathologist');
  const labId = staff.lab_id;
  const { rows: [order] } = await c.query(
    'SELECT id FROM lis.orders WHERE id = $1 AND lab_id = $2 FOR UPDATE', [orderId, labId]);
  if (!order) throw notFound('Order');

  const { rows: toRelease } = await c.query<{ id: string }>(
    `SELECT id FROM lis.order_tests WHERE order_id = $1 AND status = 'validated'`, [orderId]);
  if (toRelease.length === 0) throw conflict('No validated tests are waiting to be released');

  const { rows: [prev] } = await c.query(
    `SELECT id, version FROM lis.reports WHERE order_id = $1 AND released_at IS NOT NULL ORDER BY version DESC LIMIT 1`,
    [orderId]);
  // A test that was in a previous report and is being released again was corrected.
  let correctedIds: string[] = [];
  if (prev) {
    const { rows } = await c.query<{ order_test_id: string }>(
      `SELECT order_test_id FROM lis.report_items WHERE report_id = $1 AND order_test_id = ANY($2::uuid[])`,
      [prev.id, toRelease.map((t) => t.id)]);
    correctedIds = rows.map((r) => r.order_test_id);
  }
  const corrected = correctedIds.length > 0;
  if (corrected && !opts.amendment_reason?.trim()) {
    throw badRequest('This release corrects a previously released result; give an amendment reason');
  }

  // Discard any unreleased draft so version numbers stay contiguous.
  await c.query('DELETE FROM lis.report_items WHERE report_id IN (SELECT id FROM lis.reports WHERE order_id = $1 AND released_at IS NULL)', [orderId]);
  await c.query('DELETE FROM lis.reports WHERE order_id = $1 AND released_at IS NULL', [orderId]);

  await c.query(`UPDATE lis.order_tests SET status = 'released' WHERE order_id = $1 AND status = 'validated'`, [orderId]);
  const { rows: included } = await c.query<{ id: string }>(
    `SELECT id FROM lis.order_tests WHERE order_id = $1 AND status = 'released'`, [orderId]);

  const content = await buildReportContent(c, labId, orderId, included.map((t) => t.id));
  const policy = await distributionFor(c, labId, orderId);

  const version = prev ? prev.version + 1 : 1;
  const reason = !prev ? null : corrected ? opts.amendment_reason!.trim() : 'Additional results released';
  const { rows: [report] } = await c.query(
    `INSERT INTO lis.reports (lab_id, order_id, version, supersedes_id, clinical_status, distribution_status,
                              distribution_reason, amendment_reason, validated_by, validated_at, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10) RETURNING id`,
    [labId, orderId, version, prev?.id ?? null, corrected ? 'amended' : 'final', policy.status, policy.reason, reason,
      staff.id, content]);
  // Items are attached before the release stamp, because released reports are frozen.
  for (const t of included) {
    await c.query('INSERT INTO lis.report_items (report_id, order_id, order_test_id) VALUES ($1, $2, $3)',
      [report.id, orderId, t.id]);
  }
  await c.query('UPDATE lis.reports SET released_by = $2, released_at = now() WHERE id = $1', [report.id, staff.id]);
  return {
    ...(await getReport(c, labId, report.id)),
    /** Tests released for the first time or re-released after correction in this release. */
    released_now: toRelease.map((t) => t.id),
    corrected: correctedIds,
  };
}

async function distributionFor(c: Q, labId: string, orderId: string) {
  const { rows: [r] } = await c.query(
    `SELECT l.billing_enabled, l.hold_report_until_paid, b.due
     FROM lis.labs l LEFT JOIN lis.invoice_balances b ON b.order_id = $2
     WHERE l.id = $1`, [labId, orderId]);
  if (r.billing_enabled && r.hold_report_until_paid && r.due !== null && Number(r.due) > 0) {
    return { status: 'held', reason: AWAITING_PAYMENT };
  }
  return { status: 'authorised', reason: null };
}

async function buildReportContent(c: Q, labId: string, orderId: string, orderTestIds: string[]) {
  const { rows: [head] } = await c.query(
    `SELECT json_build_object('code', l.code, 'name', l.name, 'name_bn', l.name_bn, 'address', l.address, 'phone', l.phone) AS lab,
            json_build_object('patient_code', p.patient_code, 'full_name', p.full_name, 'full_name_bn', p.full_name_bn,
                              'sex', p.sex, 'age_days', o.patient_age_days) AS patient,
            o.order_number, o.ordered_at, d.name AS referring_doctor
     FROM lis.orders o
     JOIN lis.labs l ON l.id = o.lab_id
     JOIN lis.patients p ON p.id = o.patient_id
     LEFT JOIN lis.referring_doctors d ON d.id = o.referring_doctor_id
     WHERE o.id = $1 AND o.lab_id = $2`, [orderId, labId]);
  const tests = [];
  for (const id of orderTestIds) tests.push(await getOrderTest(c, labId, id));
  const { rows: pending } = await c.query(
    `SELECT t.code, t.name, ot.status FROM lis.order_tests ot JOIN lis.tests t ON t.id = ot.test_id
     WHERE ot.order_id = $1 AND ot.status NOT IN ('released', 'cancelled')`, [orderId]);
  return { ...head, patient: { ...head.patient, age: formatAge(head.patient.age_days) }, tests, pending };
}

export async function getReport(c: Q, labId: string, reportId: string) {
  const { rows: [r] } = await c.query(
    `SELECT r.id, r.order_id, r.version, r.supersedes_id, r.clinical_status, r.distribution_status,
            r.distribution_reason, r.amendment_reason, r.released_at, r.content, s.full_name AS released_by
     FROM lis.reports r LEFT JOIN lis.staff_users s ON s.id = r.released_by
     WHERE r.id = $1 AND r.lab_id = $2`, [reportId, labId]);
  if (!r) throw notFound('Report');
  return r;
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

export async function dailySummary(c: Q, labId: string, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Date must be YYYY-MM-DD');
  const { rows: [s] } = await c.query(
    `WITH day AS (
       SELECT ($2::date)::timestamp AT TIME ZONE 'Asia/Dhaka' AS start,
              ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dhaka' AS finish
     )
     SELECT
       (SELECT count(*)::int FROM lis.orders o, day WHERE o.lab_id = $1 AND o.ordered_at >= day.start AND o.ordered_at < day.finish) AS orders,
       (SELECT count(*)::int FROM lis.order_tests ot JOIN lis.orders o ON o.id = ot.order_id, day
          WHERE o.lab_id = $1 AND o.ordered_at >= day.start AND o.ordered_at < day.finish AND ot.status <> 'cancelled') AS tests,
       (SELECT COALESCE(sum(i.net), 0)::numeric(12,2) FROM lis.invoices i JOIN lis.orders o ON o.id = i.order_id, day
          WHERE o.lab_id = $1 AND o.ordered_at >= day.start AND o.ordered_at < day.finish) AS billed,
       (SELECT COALESCE(sum(CASE p.kind WHEN 'payment' THEN p.amount ELSE -p.amount END), 0)::numeric(12,2)
          FROM lis.payments p, day WHERE p.lab_id = $1 AND p.received_at >= day.start AND p.received_at < day.finish) AS collected,
       (SELECT COALESCE(sum(b.due), 0)::numeric(12,2) FROM lis.invoice_balances b WHERE b.lab_id = $1 AND b.due > 0) AS outstanding_all_days,
       (SELECT count(*)::int FROM lis.reports r, day WHERE r.lab_id = $1 AND r.released_at >= day.start AND r.released_at < day.finish) AS reports_released`,
    [labId, date]);
  return { date, ...s };
}
