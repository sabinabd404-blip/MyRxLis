import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { pool } from '../helpers/db.js';
import { createDxWorld, type DxWorld } from '../helpers/dxworld.js';

let app: FastifyInstance;
before(() => { app = buildApp({ db: pool }); });
after(() => app.close());

function as(orgId: string, userId: string) {
  const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url: `/dx/orgs/${orgId}${url}`, payload, headers: { 'x-dx-user': userId } });
    return { status: res.statusCode, body: res.json() };
  };
  return { get: (url: string) => call('GET', url), post: (url: string, body: object = {}) => call('POST', url, body) };
}

const orderBody = (w: DxWorld, offerForGlu?: string) => ({
  source_system: 'myrx-emr',
  source_order_id: `RX-${w.tag}`,
  patient: { identity_system: 'urn:myrx:patient', identity_value: `PT-${w.tag}` },
  encounter: { source_encounter_id: `ENC-${w.tag}` },
  ordering_practitioner_ref: 'dr-demo',
  items: [
    { canonical_code: `GLU-${w.tag}`, ...(offerForGlu ? { lab_service_offer_id: offerForGlu } : {}) },
    { canonical_code: `CREA-${w.tag}` },
  ],
});

const results = (key: string, value: number, extra: object = {}) => ({
  source_system: 'lab-lis', idempotency_key: key, status: 'final',
  observations: [{ code: 'GLU', name: 'Glucose', value, unit: 'mmol/L', reference_range: '3.9-5.5', flag: value > 5.5 ? 'H' : 'N' }],
  report: { storage_object_key: `reports/${key}.pdf` },
  ...extra,
});

test('one order, two labs, results back to the EMR through the feed', async () => {
  const w = await createDxWorld();
  const emr = as(w.clinic, w.clinician);
  const labA = as(w.labA, w.labAUser);
  const labB = as(w.labB, w.labBUser);

  // 1. The EMR sends the order; glucose goes straight to the chamber's centre (lab A).
  const created = await emr.post('/orders', orderBody(w, w.offerAGlu));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.order_number, /^DX-\d{6}-\d{6}$/);
  assert.equal(created.body.status, 'partially_assigned');
  const [gluItem, creaItem] = created.body.items;
  assert.equal(gluItem.lab, `LABA-${w.tag}`);
  assert.equal(creaItem.status, 'ordered');

  // Resending the same order is safe.
  const again = await emr.post('/orders', orderBody(w, w.offerAGlu));
  assert.equal(again.status, 200);
  assert.equal(again.body.id, created.body.id);

  // 2. The patient picks lab B near home for creatinine.
  const offers = await app.inject({ method: 'GET', url: `/dx/offers?code=CREA-${w.tag}` });
  assert.deepEqual(offers.json().map((o: { lab: string }) => o.lab), [`LABB-${w.tag}`, `LABA-${w.tag}`], 'cheapest first');
  assert.equal((await emr.post(`/orders/${created.body.id}/items/${gluItem.id}/assign`, { lab_service_offer_id: w.offerBGlu })).status, 409,
    'an investigation already with a lab cannot be sent to a second one');
  assert.equal((await emr.post(`/orders/${created.body.id}/items/${creaItem.id}/assign`, { lab_service_offer_id: w.offerAGlu })).status, 400,
    'an offer for a different test is refused');
  const assigned = await emr.post(`/orders/${created.body.id}/items/${creaItem.id}/assign`, { lab_service_offer_id: w.offerBCrea });
  assert.equal(assigned.body.status, 'assigned');

  // 3. Each lab sees only its own work.
  const queueA = (await labA.get('/work')).body;
  const queueB = (await labB.get('/work')).body;
  assert.deepEqual(queueA.map((x: { local_test_code: string }) => x.local_test_code), ['A-GLU']);
  assert.deepEqual(queueB.map((x: { local_test_code: string }) => x.local_test_code), ['B-CREA']);
  const gluAssignment = queueA[0].assignment_id;
  const creaAssignment = queueB[0].assignment_id;

  // Lab B probing lab A's assignment gets "not found", and the attempt is audited.
  assert.equal((await labB.post(`/assignments/${gluAssignment}/accept`)).status, 404);
  const { rows: denied } = await pool.query(
    `SELECT outcome, reason_code FROM audit_events WHERE resource_id = $1 AND action_code = 'assignment.accept'`, [gluAssignment]);
  assert.deepEqual(denied, [{ outcome: 'denied', reason_code: 'not_assigned_to_lab' }]);

  // 4. Labs accept; lab A holds its report until the patient pays.
  assert.equal((await labA.post(`/assignments/${gluAssignment}/accept`, { external_accession_id: 'A-ACC-1' })).body.status, 'accepted');
  assert.equal((await labB.post(`/assignments/${creaAssignment}/accept`)).status, 200);
  const held = await labA.post(`/assignments/${gluAssignment}/results`,
    results(`a-${w.tag}-1`, 7.2, { release: { decision: 'held', reason_code: 'awaiting_payment' } }));
  assert.equal(held.status, 201, JSON.stringify(held.body));

  let feed = (await emr.get('/results/feed?cursor=0')).body;
  assert.deepEqual(feed.entries, [], 'a held report is invisible to the EMR');
  const status1 = (await emr.get(`/orders/${created.body.id}`)).body;
  assert.equal(status1.items[0].result_state, 'awaiting_release');
  assert.equal(status1.items[0].results, null);

  // 5. Patient pays; the lab authorises; the EMR picks it up.
  await labA.post(`/reports/${held.body.report_version_id}/release`, { decision: 'authorised' });
  feed = (await emr.get(`/results/feed?cursor=${feed.next_cursor}`)).body;
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].event, 'available');
  assert.equal(feed.entries[0].source_order_id, `RX-${w.tag}`);
  assert.equal(feed.entries[0].results[0].value, '7.2');
  assert.equal(feed.entries[0].results[0].flag, 'H');
  let cursor = feed.next_cursor;

  // A retried result message does not create a duplicate.
  const retry = await labA.post(`/assignments/${gluAssignment}/results`, results(`a-${w.tag}-1`, 7.2));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);

  // 6. Lab B reports creatinine, authorised straight away.
  const crea = await labB.post(`/assignments/${creaAssignment}/results`, {
    ...results(`b-${w.tag}-1`, 0), observations: [{ code: 'CREA', name: 'Creatinine', value: '0.9', unit: 'mg/dL' }],
  });
  assert.equal(crea.status, 201);
  feed = (await emr.get(`/results/feed?cursor=${cursor}`)).body;
  assert.deepEqual(feed.entries.map((e: { canonical_code: string }) => e.canonical_code), [`CREA-${w.tag}`]);
  cursor = feed.next_cursor;
  assert.equal((await emr.get(`/orders/${created.body.id}`)).body.status, 'completed');

  // 7. Lab A corrects glucose: version 2 supersedes version 1.
  const corrected = await labA.post(`/assignments/${gluAssignment}/results`, results(`a-${w.tag}-2`, 6.8, { status: 'corrected' }));
  assert.equal(corrected.body.version, 2);
  feed = (await emr.get(`/results/feed?cursor=${cursor}`)).body;
  assert.equal(feed.entries[0].report_status, 'corrected');
  assert.equal(feed.entries[0].supersedes_report_version_id, held.body.report_version_id);
  assert.equal(feed.entries[0].results[0].value, '6.8');
  cursor = feed.next_cursor;

  // 8. The lab later restricts the corrected report; the EMR is told to hide it.
  await labA.post(`/reports/${corrected.body.report_version_id}/release`, { decision: 'restricted', reason_code: 'legal' });
  feed = (await emr.get(`/results/feed?cursor=${cursor}`)).body;
  assert.equal(feed.entries[0].event, 'withdrawn');
  assert.equal(feed.entries[0].results, null);

  // Patient view: only currently available, latest versions.
  const byPatient = (await emr.get(`/patients/results?system=urn:myrx:patient&value=PT-${w.tag}`)).body;
  assert.deepEqual(byPatient.map((r: { canonical_code: string }) => r.canonical_code), [`CREA-${w.tag}`]);
});

test('a lab rejection sends the investigation back for another lab', async () => {
  const w = await createDxWorld();
  const emr = as(w.clinic, w.clinician);
  const order = (await emr.post('/orders', orderBody(w, w.offerAGlu))).body;
  const assignment = (await as(w.labA, w.labAUser).get('/work')).body[0].assignment_id;
  assert.equal((await as(w.labA, w.labAUser).post(`/assignments/${assignment}/reject`, { reason: 'Analyser down' })).status, 200);
  let status = (await emr.get(`/orders/${order.id}`)).body;
  assert.equal(status.items[0].status, 'ordered');
  assert.equal(status.items[0].assignment_status, 'rejected');
  await emr.post(`/orders/${order.id}/items/${order.items[0].id}/assign`, { lab_service_offer_id: w.offerBGlu });
  status = (await emr.get(`/orders/${order.id}`)).body;
  assert.equal(status.items[0].lab, `LABB-${w.tag}`);
});

test("an EMR organisation cannot read another organisation's orders or results", async () => {
  const w = await createDxWorld();
  const order = (await as(w.clinic, w.clinician).post('/orders', orderBody(w, w.offerAGlu))).body;
  const assignment = (await as(w.labA, w.labAUser).get('/work')).body[0].assignment_id;
  await as(w.labA, w.labAUser).post(`/assignments/${assignment}/accept`);
  await as(w.labA, w.labAUser).post(`/assignments/${assignment}/results`, results(`x-${w.tag}`, 5));

  const other = as(w.otherClinic, w.otherClinician);
  assert.equal((await other.get(`/orders/${order.id}`)).status, 404);
  const feed = (await other.get('/results/feed?cursor=0')).body;
  assert.equal(feed.entries.filter((e: { order_id: string }) => e.order_id === order.id).length, 0);
  // Acting for a clinic you don't belong to is refused outright.
  assert.equal((await as(w.clinic, w.otherClinician).get(`/orders/${order.id}`)).status, 403);
  // A lab user cannot place orders.
  assert.equal((await as(w.labA, w.labAUser).post('/orders', { ...orderBody(w), source_order_id: `Z-${w.tag}` })).status, 403);
});
