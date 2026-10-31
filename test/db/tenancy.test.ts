import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectReject, inTx, makeFixture } from '../helpers/db.js';

test('an order cannot use a patient registered at another lab', () => inTx(async (c) => {
  const a = await makeFixture(c, 'LABA');
  const b = await makeFixture(c, 'LABB');
  await expectReject(c,
    `INSERT INTO lis.orders (lab_id, order_number, patient_id, patient_age_days) VALUES ($1, 'X-1', $2, 100)`,
    [a.labId, b.patientId], /orders_patient_id_lab_id_fkey/);
}));

test("an order cannot include another lab's test", () => inTx(async (c) => {
  const a = await makeFixture(c, 'LABA');
  const b = await makeFixture(c, 'LABB');
  await expectReject(c,
    `INSERT INTO lis.order_tests (lab_id, order_id, test_id, price) VALUES ($1, $2, $3, 100)`,
    [a.labId, a.orderId, b.testId], /order_tests_test_id_lab_id_fkey/);
}));

test('barcodes are unique within a lab but may repeat across labs', () => inTx(async (c) => {
  const a = await makeFixture(c, 'LABA');
  const b = await makeFixture(c, 'LABB');
  const insert = `INSERT INTO lis.specimens (lab_id, order_id, barcode, specimen_type) VALUES ($1, $2, 'BC-1', 'serum')`;
  await c.query(insert, [a.labId, a.orderId]);
  await c.query(insert, [b.labId, b.orderId]);
  await expectReject(c, insert, [a.labId, a.orderId], /specimens_lab_id_barcode_key/);
}));

test('a test can only be linked to a specimen from its own order', () => inTx(async (c) => {
  const a = await makeFixture(c, 'LABA');
  const { rows: [other] } = await c.query(
    `INSERT INTO lis.orders (lab_id, order_number, patient_id, patient_age_days) VALUES ($1, 'ORD-0002', $2, 100) RETURNING id`,
    [a.labId, a.patientId]);
  const { rows: [spec] } = await c.query(
    `INSERT INTO lis.specimens (lab_id, order_id, barcode, specimen_type) VALUES ($1, $2, 'BC-9', 'serum') RETURNING id`,
    [a.labId, other.id]);
  await expectReject(c, `UPDATE lis.order_tests SET specimen_id = $2 WHERE id = $1`,
    [a.orderTestId, spec.id], /order_tests_specimen_id_order_id_fkey/);
}));

test('a retried DX order with the same external reference is rejected', () => inTx(async (c) => {
  const a = await makeFixture(c);
  const insert = `INSERT INTO lis.orders (lab_id, order_number, patient_id, patient_age_days, source, external_ref)
                  VALUES ($1, $2, $3, 100, 'myrx_dx', 'DX-100001')`;
  await c.query(insert, [a.labId, 'ORD-DX-1', a.patientId]);
  await expectReject(c, insert, [a.labId, 'ORD-DX-2', a.patientId], /orders_external_ref_uq/);
}));

test('a DX order must carry its external reference', () => inTx(async (c) => {
  const a = await makeFixture(c);
  const err = await expectReject(c,
    `INSERT INTO lis.orders (lab_id, order_number, patient_id, patient_age_days, source) VALUES ($1, 'X', $2, 1, 'myrx_dx')`,
    [a.labId, a.patientId]);
  assert.equal(err.code, '23514');
}));
