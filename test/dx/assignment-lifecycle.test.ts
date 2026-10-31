// Port of the revised test_assignment_lifecycle.sql (T1–T8, R1–R3).
// T3–T6 were open gaps on the original database; migration 0004 closes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectReject, inTx } from '../helpers/db.js';
import { assign, makeDxFixture } from '../helpers/dx.js';

test('T1: a second active assignment for the same item is rejected', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1, 'accepted');
  await expectReject(c,
    `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number)
     VALUES ($1, $2, $3, $4, 2)`, [f.itemGlu, f.offerBGlu, f.orgB, f.branchB], /uq_assignment_one_active_per_item/);
}));

test('T2: rejecting an assignment requires a reason', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA);
  await expectReject(c, `UPDATE assignment_attempts SET status = 'rejected' WHERE id = $1`, [a],
    /assignment_attempts_check/);
}));

test('T3: an existing assignment cannot be redirected to another lab', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA);
  await expectReject(c,
    `UPDATE assignment_attempts SET lab_service_offer_id = $2, organisation_id = $3, branch_id = $4 WHERE id = $1`,
    [a, f.offerBGlu, f.orgB, f.branchB], /cannot be redirected/);
}));

test('T4: an attempt number cannot be rewritten', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA);
  await expectReject(c, `UPDATE assignment_attempts SET attempt_number = 7 WHERE id = $1`, [a], /renumbered/);
}));

test('T5: assignment history cannot be deleted', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA);
  await expectReject(c, `DELETE FROM assignment_attempts WHERE id = $1`, [a], /cannot be deleted/);
}));

test('T6: a rejected assignment cannot be reopened', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA);
  await c.query(`UPDATE assignment_attempts SET status = 'rejected', rejection_reason = 'Test not available today' WHERE id = $1`, [a]);
  await expectReject(c, `UPDATE assignment_attempts SET status = 'offered' WHERE id = $1`, [a], /is closed/);
}));

test('T7: an offer cannot be paired with another organisation', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await expectReject(c,
    `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number)
     VALUES ($1, $2, $3, $4, 1)`, [f.itemGlu, f.offerBGlu, f.orgA, f.branchA]);
}));

test('T8: an offer for the wrong test cannot be assigned', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await expectReject(c,
    `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number)
     VALUES ($1, $2, $3, $4, 1)`, [f.itemCrea, f.offerAGlu, f.orgA, f.branchA], /Assignment rejected/);
}));

test('status cannot skip backwards on an open attempt', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1, 'in_progress');
  await expectReject(c, `UPDATE assignment_attempts SET status = 'offered' WHERE id = $1`, [a],
    /in_progress -> offered/);
}));

test('R1–R3: reject, reassign to another lab as attempt 2, and keep both in history', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a1 = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1);
  await c.query(`UPDATE assignment_attempts SET status = 'rejected', rejection_reason = 'Analyser down',
                 responded_at = now(), closed_at = now() WHERE id = $1`, [a1]);
  const a2 = await assign(c, f.itemGlu, f.offerBGlu, f.orgB, f.branchB, 2);
  await c.query(`UPDATE assignment_attempts SET status = 'accepted', external_accession_id = 'B-ACC-1' WHERE id = $1`, [a2]);
  const { rows } = await c.query(
    `SELECT attempt_number, status FROM assignment_attempts WHERE order_item_id = $1 ORDER BY attempt_number`, [f.itemGlu]);
  assert.deepEqual(rows, [{ attempt_number: 1, status: 'rejected' }, { attempt_number: 2, status: 'accepted' }]);
}));
