import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectReject, inTx, makeFixture } from '../helpers/db.js';

test('invoice balance reflects discount, payments and refunds', () => inTx(async (c) => {
  const f = await makeFixture(c);
  const { rows: [inv] } = await c.query(
    `INSERT INTO lis.invoices (lab_id, order_id, gross, discount) VALUES ($1, $2, 4000, 400) RETURNING id, net`,
    [f.labId, f.orderId]);
  assert.equal(Number(inv.net), 3600);
  const pay = `INSERT INTO lis.payments (lab_id, invoice_id, kind, amount, method, receipt_number) VALUES ($1, $2, $3, $4, $5, $6)`;
  await c.query(pay, [f.labId, inv.id, 'payment', 2000, 'cash', 'MR-1']);
  await c.query(pay, [f.labId, inv.id, 'payment', 1000, 'bkash', 'MR-2']);
  await c.query(pay, [f.labId, inv.id, 'refund', 200, 'cash', 'MR-3']);
  const { rows: [bal] } = await c.query(`SELECT paid, due FROM lis.invoice_balances WHERE invoice_id = $1`, [inv.id]);
  assert.equal(Number(bal.paid), 2800);
  assert.equal(Number(bal.due), 800);
}));

test('discount cannot exceed the gross amount', () => inTx(async (c) => {
  const f = await makeFixture(c);
  await expectReject(c, `INSERT INTO lis.invoices (lab_id, order_id, gross, discount) VALUES ($1, $2, 100, 150)`,
    [f.labId, f.orderId], /invoices_check/);
}));

test('money receipt numbers are unique within a lab', () => inTx(async (c) => {
  const f = await makeFixture(c);
  const { rows: [inv] } = await c.query(
    `INSERT INTO lis.invoices (lab_id, order_id, gross) VALUES ($1, $2, 500) RETURNING id`, [f.labId, f.orderId]);
  const pay = `INSERT INTO lis.payments (lab_id, invoice_id, amount, method, receipt_number) VALUES ($1, $2, 100, 'cash', 'MR-1')`;
  await c.query(pay, [f.labId, inv.id]);
  await expectReject(c, pay, [f.labId, inv.id], /payments_lab_id_receipt_number_key/);
}));

test('a payment cannot be zero or negative', () => inTx(async (c) => {
  const f = await makeFixture(c);
  const { rows: [inv] } = await c.query(
    `INSERT INTO lis.invoices (lab_id, order_id, gross) VALUES ($1, $2, 500) RETURNING id`, [f.labId, f.orderId]);
  await expectReject(c, `INSERT INTO lis.payments (lab_id, invoice_id, amount, method, receipt_number) VALUES ($1, $2, 0, 'cash', 'MR-9')`,
    [f.labId, inv.id], /payments_amount_check/);
}));
