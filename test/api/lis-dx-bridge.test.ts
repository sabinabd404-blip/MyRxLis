import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { pool } from '../helpers/db.js';
import { createDxWorld, type DxWorld } from '../helpers/dxworld.js';
import { createTestLab, type TestLab } from '../helpers/lab.js';

let app: FastifyInstance;
before(() => { app = buildApp({ db: pool }); });
after(() => app.close());

/** Connect an LIS lab to DX lab A, with its tests mapped to the DX catalogue. */
async function connect(lab: TestLab, w: DxWorld) {
  const { rows: [svc] } = await pool.query(`INSERT INTO users (display_name) VALUES ('LIS service') RETURNING id`);
  await pool.query(`INSERT INTO organisation_memberships (organisation_id, user_id, role_code) VALUES ($1, $2, 'integration_service')`,
    [w.labA, svc.id]);
  await pool.query('UPDATE lis.labs SET dx_organisation_id = $2, dx_service_user_id = $3 WHERE id = $1', [lab.labId, w.labA, svc.id]);
  await pool.query('UPDATE lis.tests SET myrx_test_code = $2 WHERE id = $1', [lab.fbs, `GLU-${w.tag}`]);
  const { rows: [crea] } = await pool.query(
    `INSERT INTO lis.tests (lab_id, code, name, specimen_type, price, myrx_test_code)
     VALUES ($1, 'CREAT', 'Serum creatinine', 'Serum', 400, $2) RETURNING id`, [lab.labId, `CREA-${w.tag}`]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO lis.test_parameters (test_id, code, name, result_type, unit) VALUES ($1, 'CRE', 'Creatinine', 'numeric', 'mg/dL') RETURNING id`,
    [crea.id]);
  await pool.query('INSERT INTO lis.reference_ranges (parameter_id, low, high) VALUES ($1, 0.6, 1.2)', [p.id]);
}

function lisApi(lab: TestLab, staffId: string) {
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const res = await app.inject({ method, url: `/labs/${lab.labId}${url}`, payload, headers: { 'x-staff-id': staffId } });
    return { status: res.statusCode, body: res.json() };
  };
  return { get: (u: string) => call('GET', u), post: (u: string, b: object = {}) => call('POST', u, b), put: (u: string, b: object) => call('PUT', u, b) };
}

function emrApi(w: DxWorld) {
  const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url: `/dx/orgs/${w.clinic}${url}`, payload, headers: { 'x-dx-user': w.clinician } });
    return { status: res.statusCode, body: res.json() };
  };
  return { get: (u: string) => call('GET', u), post: (u: string, b: object) => call('POST', u, b) };
}

test('a doctor\'s DX order is worked in LIS Lite and the results reach the EMR', async () => {
  const w = await createDxWorld();
  const lab = await createTestLab({ holdUntilPaid: true });
  await connect(lab, w);
  const desk = lisApi(lab, lab.reception);
  const tech = lisApi(lab, lab.tech);
  const path = lisApi(lab, lab.path);
  const emr = emrApi(w);

  // The doctor orders glucose and creatinine at the chamber's own centre (lab A, running LIS Lite).
  const order = await emr.post('/orders', {
    source_system: 'myrx-emr', source_order_id: `RX-${w.tag}`,
    patient: { identity_system: 'urn:myrx:patient', identity_value: `PT-${w.tag}` },
    items: [
      { canonical_code: `GLU-${w.tag}`, lab_service_offer_id: w.offerAGlu },
      { canonical_code: `CREA-${w.tag}`, lab_service_offer_id: w.offerACrea },
    ],
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));

  // The order shows up in the lab's LIS inbox, mapped to its own tests.
  const inbox = (await desk.get('/dx/inbox')).body;
  assert.equal(inbox.length, 2, JSON.stringify(inbox));
  assert.ok(inbox.every((i: { lis_test: unknown }) => i.lis_test));

  // The patient arrives; reception imports the order and registers them.
  const imported = await desk.post('/dx/import', {
    assignment_ids: inbox.map((i: { assignment_id: string }) => i.assignment_id),
    patient: { full_name: 'Karim Uddin', sex: 'male' }, age: { years: 52 },
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.source, 'myrx_dx');
  assert.equal(imported.body.tests.length, 2);
  assert.equal((await desk.get('/dx/inbox')).body.length, 0, 'imported items leave the inbox');
  assert.equal((await emr.get(`/orders/${order.body.id}`)).body.status, 'in_progress', 'accepted in DX');

  const fbs = imported.body.tests.find((t: { code: string }) => t.code === 'FBS');
  const creat = imported.body.tests.find((t: { code: string }) => t.code === 'CREAT');
  for (const specimen of new Set([fbs.specimen_id, creat.specimen_id])) await desk.post(`/specimens/${specimen}/collect`);

  // Glucose is done first. The lab holds reports until paid, so the EMR sees nothing yet.
  await tech.put(`/order-tests/${fbs.id}/results`, { results: [{ parameter_code: 'GLU', value: 7.2 }] });
  await path.post(`/order-tests/${fbs.id}/validate`);
  const v1 = await path.post(`/orders/${imported.body.id}/release`);
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  assert.equal(v1.body.dx_results_sent, 1);
  let feed = (await emr.get('/results/feed?cursor=0')).body;
  assert.equal(feed.entries.length, 0);

  // Paying the bill releases it to the EMR.
  const pay = await desk.post(`/orders/${imported.body.id}/payments`, { amount: Number(imported.body.invoice.due), method: 'nagad' });
  assert.equal(pay.body.dx_decisions_updated, 1);
  feed = (await emr.get(`/results/feed?cursor=${feed.next_cursor}`)).body;
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].event, 'available');
  assert.equal(feed.entries[0].canonical_code, `GLU-${w.tag}`);
  assert.deepEqual(feed.entries[0].results.map((r: { code: string; value: string; flag: string; reference_range: string }) =>
    [r.code, r.value, r.flag, r.reference_range]), [['GLU', '7.2', 'H', '3.9-5.5']]);
  let cursor = feed.next_cursor;

  // Creatinine follows; only the new result is sent, not glucose again.
  await tech.put(`/order-tests/${creat.id}/results`, { results: [{ parameter_code: 'CRE', value: 1.0 }] });
  await path.post(`/order-tests/${creat.id}/validate`);
  const v2 = await path.post(`/orders/${imported.body.id}/release`);
  assert.equal(v2.body.dx_results_sent, 1);
  feed = (await emr.get(`/results/feed?cursor=${cursor}`)).body;
  assert.deepEqual(feed.entries.map((e: { canonical_code: string }) => e.canonical_code), [`CREA-${w.tag}`]);
  cursor = feed.next_cursor;
  assert.equal((await emr.get(`/orders/${order.body.id}`)).body.status, 'completed');

  // A correction in the LIS reaches the EMR as a corrected version.
  await path.post(`/order-tests/${fbs.id}/reopen`);
  await tech.put(`/order-tests/${fbs.id}/results`, { results: [{ parameter_code: 'GLU', value: 6.8 }] });
  await path.post(`/order-tests/${fbs.id}/validate`);
  const v3 = await path.post(`/orders/${imported.body.id}/release`, { amendment_reason: 'Transcription error' });
  assert.equal(v3.body.dx_results_sent, 1);
  feed = (await emr.get(`/results/feed?cursor=${cursor}`)).body;
  assert.equal(feed.entries[0].report_status, 'corrected');
  assert.equal(feed.entries[0].results[0].value, '6.8');
  assert.ok(feed.entries[0].supersedes_report_version_id);
});

test('a returning patient is matched by their MyRx identity', async () => {
  const w = await createDxWorld();
  const lab = await createTestLab({ holdUntilPaid: false });
  await connect(lab, w);
  const desk = lisApi(lab, lab.reception);
  const emr = emrApi(w);
  const send = (n: number) => emr.post('/orders', {
    source_system: 'myrx-emr', source_order_id: `RX-${w.tag}-${n}`,
    patient: { identity_system: 'urn:myrx:patient', identity_value: `PT-${w.tag}` },
    items: [{ canonical_code: `GLU-${w.tag}`, lab_service_offer_id: w.offerAGlu }],
  });
  await send(1);
  const first = (await desk.get('/dx/inbox')).body[0];
  const a = await desk.post('/dx/import', { assignment_ids: [first.assignment_id], patient: { full_name: 'Karim Uddin', sex: 'male' }, age: { years: 52 } });
  await send(2);
  const second = (await desk.get('/dx/inbox')).body[0];
  const b = await desk.post('/dx/import', { assignment_ids: [second.assignment_id], age: { years: 52 } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.patient.id, a.body.patient.id);
});

test('a lab that is not connected to DX has no inbox', async () => {
  const lab = await createTestLab();
  const res = await lisApi(lab, lab.reception).get('/dx/inbox');
  assert.equal(res.status, 409);
});
