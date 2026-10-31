import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTest, expectReject, inTx, makeFixture } from '../helpers/db.js';

const insertResult = `INSERT INTO lis.results (order_test_id, test_id, parameter_id, value_numeric, unit)
                      VALUES ($1, $2, $3, $4, 'mmol/L')`;

test('a result must be for a parameter of the ordered test', () => inTx(async (c) => {
  const f = await makeFixture(c);
  const { rows: [otherTest] } = await c.query(
    `INSERT INTO lis.tests (lab_id, code, name, price) VALUES ($1, 'TSH', 'TSH', 900) RETURNING id`, [f.labId]);
  const { rows: [otherParam] } = await c.query(
    `INSERT INTO lis.test_parameters (test_id, code, name, result_type) VALUES ($1, 'TSH', 'TSH', 'numeric') RETURNING id`,
    [otherTest.id]);
  // Claiming the TSH test id fails the order_test link...
  await expectReject(c, insertResult, [f.orderTestId, otherTest.id, otherParam.id, 1], /results_order_test_id_test_id_fkey/);
  // ...and keeping the FBS test id fails the parameter link.
  await expectReject(c, insertResult, [f.orderTestId, f.testId, otherParam.id, 1], /results_parameter_id_test_id_fkey/);
}));

test('test status can only move along allowed steps', () => inTx(async (c) => {
  const f = await makeFixture(c);
  await expectReject(c, `UPDATE lis.order_tests SET status = 'released' WHERE id = $1`, [f.orderTestId],
    /Invalid test status change: ordered -> released/);
  await advanceTest(c, f.orderTestId, 'in_progress');
  await expectReject(c, `UPDATE lis.order_tests SET status = 'ordered' WHERE id = $1`, [f.orderTestId],
    /in_progress -> ordered/);
}));

test('cancelling a test needs a reason, and a cancelled test stays cancelled', () => inTx(async (c) => {
  const f = await makeFixture(c);
  await expectReject(c, `UPDATE lis.order_tests SET status = 'cancelled' WHERE id = $1`, [f.orderTestId],
    /order_tests_check/);
  await c.query(`UPDATE lis.order_tests SET status = 'cancelled', cancelled_reason = 'Patient left' WHERE id = $1`,
    [f.orderTestId]);
  await expectReject(c, `UPDATE lis.order_tests SET status = 'collected' WHERE id = $1`, [f.orderTestId],
    /cancelled -> collected/);
}));

test('results lock at validation and reopen only for an amendment', () => inTx(async (c) => {
  const f = await makeFixture(c);
  await advanceTest(c, f.orderTestId, 'in_progress');
  await c.query(insertResult, [f.orderTestId, f.testId, f.paramId, 5.4]);
  await c.query(`UPDATE lis.results SET value_numeric = 5.6 WHERE order_test_id = $1`, [f.orderTestId]);

  await advanceTest(c, f.orderTestId, 'validated');
  await expectReject(c, `UPDATE lis.results SET value_numeric = 9.9 WHERE order_test_id = $1`, [f.orderTestId],
    /Results are locked: test status is validated/);
  await expectReject(c, `DELETE FROM lis.results WHERE order_test_id = $1`, [f.orderTestId], /locked/);

  await c.query(`UPDATE lis.order_tests SET status = 'released' WHERE id = $1`, [f.orderTestId]);
  await expectReject(c, `UPDATE lis.results SET value_numeric = 9.9 WHERE order_test_id = $1`, [f.orderTestId],
    /test status is released/);

  // Amendment path: reopen, correct, and the value changes.
  await c.query(`UPDATE lis.order_tests SET status = 'resulted' WHERE id = $1`, [f.orderTestId]);
  await c.query(`UPDATE lis.results SET value_numeric = 6.1 WHERE order_test_id = $1`, [f.orderTestId]);
  const { rows: [r] } = await c.query(`SELECT value_numeric FROM lis.results WHERE order_test_id = $1`, [f.orderTestId]);
  assert.equal(Number(r.value_numeric), 6.1);
}));

test('a result needs a value', () => inTx(async (c) => {
  const f = await makeFixture(c);
  await expectReject(c,
    `INSERT INTO lis.results (order_test_id, test_id, parameter_id) VALUES ($1, $2, $3)`,
    [f.orderTestId, f.testId, f.paramId], /results_check/);
}));

test('reference ranges must be sensible', () => inTx(async (c) => {
  const f = await makeFixture(c);
  await expectReject(c, `INSERT INTO lis.reference_ranges (parameter_id, low, high) VALUES ($1, 7, 3)`, [f.paramId]);
  await expectReject(c, `INSERT INTO lis.reference_ranges (parameter_id, age_min_days, age_max_days, low) VALUES ($1, 100, 10, 1)`, [f.paramId]);
  await expectReject(c, `INSERT INTO lis.reference_ranges (parameter_id) VALUES ($1)`, [f.paramId]);
  await c.query(`INSERT INTO lis.reference_ranges (parameter_id, sex, low, high) VALUES ($1, 'female', 3.9, 5.5)`, [f.paramId]);
}));
