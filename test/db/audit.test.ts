import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTest, expectReject, inTx, makeFixture } from '../helpers/db.js';

test('result changes are audited with the acting user', () => inTx(async (c) => {
  const f = await makeFixture(c);
  await advanceTest(c, f.orderTestId, 'in_progress');
  await c.query(`SELECT set_config('lis.actor', $1, true)`, [f.staffId]);
  const { rows: [r] } = await c.query(
    `INSERT INTO lis.results (order_test_id, test_id, parameter_id, value_numeric) VALUES ($1, $2, $3, 5.4) RETURNING id`,
    [f.orderTestId, f.testId, f.paramId]);
  await c.query(`UPDATE lis.results SET value_numeric = 5.8 WHERE id = $1`, [r.id]);
  const { rows } = await c.query(
    `SELECT action, actor, old_row->>'value_numeric' AS old_v, new_row->>'value_numeric' AS new_v
     FROM lis.audit_events WHERE table_name = 'results' AND row_id = $1 ORDER BY id`, [r.id]);
  assert.deepEqual(rows.map((x) => [x.action, x.actor, x.old_v, x.new_v]), [
    ['INSERT', f.staffId, null, '5.4'],
    ['UPDATE', f.staffId, '5.4', '5.8'],
  ]);
}));

test('audit events cannot be altered or deleted', () => inTx(async (c) => {
  await makeFixture(c);
  await expectReject(c, `UPDATE lis.audit_events SET actor = 'someone else'`, [], /append-only/);
  await expectReject(c, `DELETE FROM lis.audit_events`, [], /append-only/);
}));
