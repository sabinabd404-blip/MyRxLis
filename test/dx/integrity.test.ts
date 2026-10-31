// Migration 0003 (integrity hardening): one test per protection.
import { test } from 'node:test';
import { expectReject, inTx } from '../helpers/db.js';
import { assign, makeDxFixture, resultSet } from '../helpers/dx.js';

test('1. an assignment must use an offer for the requested test', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  // Glucose item assigned with Lab A's creatinine offer.
  await expectReject(c,
    `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number)
     VALUES ($1, $2, $3, $4, 1)`, [f.itemGlu, f.offerACrea, f.orgA, f.branchA], /Assignment rejected/);
}));

test("1. an assignment cannot pair a lab's offer with another organisation", () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await expectReject(c,
    `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number)
     VALUES ($1, $2, $3, $4, 1)`, [f.itemGlu, f.offerAGlu, f.orgB, f.branchB]);
}));

test('2. an observation must belong to the order item of its result set', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1, 'accepted');
  const rs = await resultSet(c, a, 'k1');
  await c.query(`INSERT INTO observation_results (result_set_id, order_item_id, observation_name, value_numeric)
                 VALUES ($1, $2, 'Glucose', 5.4)`, [rs, f.itemGlu]);
  await expectReject(c,
    `INSERT INTO observation_results (result_set_id, order_item_id, observation_name, value_numeric)
     VALUES ($1, $2, 'Creatinine', 1.0)`, [rs, f.itemCrea], /Observation rejected/);
}));

test('4. an order and its encounter must be for the same patient', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await expectReject(c,
    `INSERT INTO diagnostic_orders (order_number, source_system, source_order_id, patient_identity_ref_id, encounter_id)
     VALUES ('DX-T-9', 'myrx-emr', 'O-9', $1, $2)`, [f.otherPatient, f.encounter], /Order rejected/);
}));

test('5. an authorisation and its order must be for the same patient', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  await c.query(`INSERT INTO patient_authorisations (patient_identity_ref_id, order_id, authorised_by_ref, purpose)
                 VALUES ($1, $2, 'patient', 'lab_selection')`, [f.patient, f.order]);
  await expectReject(c,
    `INSERT INTO patient_authorisations (patient_identity_ref_id, order_id, authorised_by_ref, purpose)
     VALUES ($1, $2, 'patient', 'lab_selection')`, [f.otherPatient, f.order], /Authorisation rejected/);
}));
