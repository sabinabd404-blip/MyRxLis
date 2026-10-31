// Migration 0005: the lab's distribution decision is separate from the immutable report version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectReject, inTx } from '../helpers/db.js';
import { assign, makeDxFixture, reportVersion } from '../helpers/dx.js';

test('a report is held until the lab authorises it, and the latest decision wins', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1, 'accepted');
  const v1 = await reportVersion(c, a, 1);
  const status = async () =>
    (await c.query(`SELECT decision, reason_code FROM report_release_status WHERE report_version_id = $1`, [v1])).rows[0];

  assert.deepEqual(await status(), { decision: 'held', reason_code: null });

  const decide = `INSERT INTO report_release_decisions (report_version_id, decision, reason_code, decided_by_user_id)
                  VALUES ($1, $2, $3, $4)`;
  await c.query(decide, [v1, 'held', 'awaiting_payment', f.userA]);
  assert.deepEqual(await status(), { decision: 'held', reason_code: 'awaiting_payment' });

  await c.query(decide, [v1, 'authorised', null, f.userA]);
  assert.deepEqual(await status(), { decision: 'authorised', reason_code: null });
}));

test('holding or restricting a report needs a reason, and decisions are append-only', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1, 'accepted');
  const v1 = await reportVersion(c, a, 1);
  await expectReject(c,
    `INSERT INTO report_release_decisions (report_version_id, decision, decided_by_service) VALUES ($1, 'restricted', 'lis')`,
    [v1], /report_release_decisions_check/);
  const { rows: [d] } = await c.query(
    `INSERT INTO report_release_decisions (report_version_id, decision, decided_by_service) VALUES ($1, 'authorised', 'lis') RETURNING id`,
    [v1]);
  await expectReject(c, `UPDATE report_release_decisions SET decision = 'held' WHERE id = $1`, [d.id], /append-only/);
  await expectReject(c, `DELETE FROM report_release_decisions WHERE id = $1`, [d.id], /append-only/);
}));
