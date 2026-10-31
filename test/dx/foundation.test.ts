// Ported from MyRx_DX_Database_Foundation_v0.1/validation.sql (DB-004 to DB-006)
// plus the result idempotency key.
import { test } from 'node:test';
import { expectReject, inTx } from '../helpers/db.js';
import { assign, makeDxFixture, resultSet } from '../helpers/dx.js';

test('DB-004: an invalid assignment status is rejected', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await expectReject(c,
    `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number, status)
     VALUES ($1, $2, $3, $4, 1, 'made_up_status')`,
    [f.itemGlu, f.offerAGlu, f.orgA, f.branchA], /assignment_attempts_status_check/);
}));

test('DB-005: a second active assignment for the same item is rejected', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1, 'offered');
  await expectReject(c,
    `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number, status)
     VALUES ($1, $2, $3, $4, 2, 'accepted')`,
    [f.itemGlu, f.offerBGlu, f.orgB, f.branchB], /uq_assignment_one_active_per_item/);
}));

test('DB-006: a duplicate source order from the same system is rejected', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await expectReject(c,
    `INSERT INTO diagnostic_orders (order_number, source_system, source_order_id, patient_identity_ref_id)
     VALUES ('DX-T-2', 'myrx-emr', 'O-1', $1)`, [f.patient], /diagnostic_orders_source_system_source_order_id_key/);
}));

test('API-003 (database part): a replayed result payload cannot create a second result set', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1, 'accepted');
  await resultSet(c, a, 'msg-001');
  await expectReject(c,
    `INSERT INTO result_sets (assignment_attempt_id, source_system, idempotency_key) VALUES ($1, 'lab-a-lis', 'msg-001')`,
    [a], /result_sets_source_system_idempotency_key_key/);
}));
