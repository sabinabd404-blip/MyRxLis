import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { expectReject, inTx, makeFixture, type Fixture } from '../helpers/db.js';

async function releasedReport(c: pg.PoolClient, f: Fixture): Promise<string> {
  const { rows: [r] } = await c.query(
    `INSERT INTO lis.reports (lab_id, order_id, version, clinical_status, distribution_status,
                              validated_by, validated_at, released_by, released_at, content)
     VALUES ($1, $2, 1, 'final', 'authorised', $3, now(), $3, now(), '{"GLU": 5.4}')
     RETURNING id`, [f.labId, f.orderId, f.pathologistId]);
  return r.id;
}

test('a released report cannot be edited or deleted', () => inTx(async (c) => {
  const f = await makeFixture(c);
  const id = await releasedReport(c, f);
  await expectReject(c, `UPDATE lis.reports SET content = '{"GLU": 9.9}' WHERE id = $1`, [id], /immutable/);
  await expectReject(c, `UPDATE lis.reports SET clinical_status = 'preliminary' WHERE id = $1`, [id], /immutable/);
  await expectReject(c, `DELETE FROM lis.reports WHERE id = $1`, [id], /cannot be deleted/);
}));

test('the lab can still change who may receive a released report', () => inTx(async (c) => {
  const f = await makeFixture(c);
  const id = await releasedReport(c, f);
  await expectReject(c, `UPDATE lis.reports SET distribution_status = 'restricted' WHERE id = $1`, [id],
    /reports_check/); // restricting needs a reason
  await c.query(`UPDATE lis.reports SET distribution_status = 'restricted', distribution_reason = 'Lab policy' WHERE id = $1`, [id]);
  const { rows: [r] } = await c.query(`SELECT distribution_status FROM lis.reports WHERE id = $1`, [id]);
  assert.equal(r.distribution_status, 'restricted');
}));

test('a report cannot be marked released without content and a releasing user', () => inTx(async (c) => {
  const f = await makeFixture(c);
  await expectReject(c,
    `INSERT INTO lis.reports (lab_id, order_id, version, released_at) VALUES ($1, $2, 1, now())`,
    [f.labId, f.orderId], /reports_check/);
}));

test('an amended version must supersede a report of the same order and give a reason', () => inTx(async (c) => {
  const f = await makeFixture(c);
  const v1 = await releasedReport(c, f);
  await expectReject(c,
    `INSERT INTO lis.reports (lab_id, order_id, version, clinical_status) VALUES ($1, $2, 2, 'amended')`,
    [f.labId, f.orderId], /reports_check/);

  const { rows: [otherOrder] } = await c.query(
    `INSERT INTO lis.orders (lab_id, order_number, patient_id, patient_age_days) VALUES ($1, 'ORD-0002', $2, 100) RETURNING id`,
    [f.labId, f.patientId]);
  await expectReject(c,
    `INSERT INTO lis.reports (lab_id, order_id, version, supersedes_id, amendment_reason, clinical_status)
     VALUES ($1, $2, 2, $3, 'Transcription error', 'amended')`,
    [f.labId, otherOrder.id, v1], /reports_supersedes_id_order_id_fkey/);

  await c.query(
    `INSERT INTO lis.reports (lab_id, order_id, version, supersedes_id, amendment_reason, clinical_status)
     VALUES ($1, $2, 2, $3, 'Transcription error', 'amended')`,
    [f.labId, f.orderId, v1]);
  await expectReject(c,
    `INSERT INTO lis.reports (lab_id, order_id, version, supersedes_id, amendment_reason)
     VALUES ($1, $2, 2, $3, 'Duplicate version')`,
    [f.labId, f.orderId, v1], /reports_order_id_version_key/);
}));

test("report items must belong to the report's order and freeze on release", () => inTx(async (c) => {
  const f = await makeFixture(c);
  const g = await makeFixture(c, 'LAB2');
  const { rows: [draft] } = await c.query(
    `INSERT INTO lis.reports (lab_id, order_id, version) VALUES ($1, $2, 1) RETURNING id`, [f.labId, f.orderId]);
  await expectReject(c,
    `INSERT INTO lis.report_items (report_id, order_id, order_test_id) VALUES ($1, $2, $3)`,
    [draft.id, f.orderId, g.orderTestId], /report_items_order_test_id_order_id_fkey/);
  await c.query(`INSERT INTO lis.report_items (report_id, order_id, order_test_id) VALUES ($1, $2, $3)`,
    [draft.id, f.orderId, f.orderTestId]);
  await c.query(
    `UPDATE lis.reports SET clinical_status = 'final', released_by = $2, released_at = now(), content = '{}' WHERE id = $1`,
    [draft.id, f.pathologistId]);
  await expectReject(c, `DELETE FROM lis.report_items WHERE report_id = $1`, [draft.id], /cannot change/);
}));
