import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { pool } from '../helpers/db.js';
import { staffAuth } from '../helpers/auth.js';
import { createTestLab, type TestLab } from '../helpers/lab.js';

let app: FastifyInstance;
before(() => { app = buildApp({ db: pool }); });
after(() => app.close());

function api(lab: TestLab, staffId: string) {
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const res = await app.inject({
      method, url: `/labs/${lab.labId}${url}`, payload,
      headers: await staffAuth(lab.labId, staffId),
    });
    return { status: res.statusCode, body: res.json() };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: object = {}) => call('POST', url, payload),
    put: (url: string, payload: object) => call('PUT', url, payload),
  };
}

async function registerAndOrder(lab: TestLab, discount = 100) {
  const desk = api(lab, lab.reception);
  const patient = await desk.post('/patients', { full_name: 'Rahima Begum', sex: 'female', phone: '01711000000' });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));
  const order = await desk.post('/orders', {
    patient_id: patient.body.id, age: { years: 40 }, test_ids: [lab.fbs, lab.lipid], discount,
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  return { patient: patient.body, order: order.body };
}

interface OrderTestRow { id: string; code: string; specimen_id: string; status: string }
const testRow = (order: { tests: OrderTestRow[] }, code: string): OrderTestRow => {
  const row = order.tests.find((t) => t.code === code);
  assert.ok(row, `order has no ${code} test`);
  return row;
};

test('full LIS Lite day: register, bill, collect, result, validate, release, settle, amend', async () => {
  const lab = await createTestLab({ holdUntilPaid: true });
  const desk = api(lab, lab.reception);
  const tech = api(lab, lab.tech);
  const path = api(lab, lab.path);

  // Registration and ordering
  const { patient, order } = await registerAndOrder(lab);
  assert.match(patient.patient_code, /^P-\d{6}$/);
  assert.match(order.order_number, /^\d{6}-\d{4}$/);
  assert.equal(order.age, '40 Y');
  assert.equal(order.tests.length, 2);
  assert.equal(new Set(order.tests.map((t: { barcode: string }) => t.barcode)).size, 2, 'one barcode per specimen type');
  assert.deepEqual([Number(order.invoice.gross), Number(order.invoice.net), Number(order.invoice.due)], [1700, 1600, 1600]);

  // Part payment, with a money receipt number
  const pay1 = await desk.post(`/orders/${order.id}/payments`, { amount: 1000, method: 'bkash' });
  assert.equal(pay1.status, 201);
  assert.match(pay1.body.payment.receipt_number, /^MR-\d{6}-\d{4}$/);
  assert.equal(Number(pay1.body.balance.due), 600);

  // Results need a collected specimen first
  const fbs = testRow(order, 'FBS');
  const lipid = testRow(order, 'LIPID');
  const early = await tech.put(`/order-tests/${fbs.id}/results`, { results: [{ parameter_code: 'GLU', value: 7.2 }] });
  assert.equal(early.status, 409);

  for (const t of [fbs, lipid]) {
    assert.equal((await desk.post(`/specimens/${t.specimen_id}/collect`)).status, 200);
    assert.equal((await tech.post(`/specimens/${t.specimen_id}/receive`)).status, 200);
  }

  // Result entry flags against the reference range
  const fbsResult = await tech.put(`/order-tests/${fbs.id}/results`, { results: [{ parameter_code: 'GLU', value: '7.2' }] });
  assert.equal(fbsResult.status, 200, JSON.stringify(fbsResult.body));
  assert.equal(fbsResult.body.status, 'resulted');
  assert.equal(fbsResult.body.results[0].flag, 'H');

  const partLipid = await tech.put(`/order-tests/${lipid.id}/results`, { results: [{ parameter_code: 'CHOL', value: 180 }] });
  assert.equal(partLipid.body.status, 'in_progress', 'not resulted until every parameter has a value');

  // Only a pathologist validates and releases
  assert.equal((await tech.post(`/order-tests/${fbs.id}/validate`)).status, 403);
  assert.equal((await path.post(`/order-tests/${fbs.id}/validate`)).body.status, 'validated');

  // First release: final clinically, but held from distribution because money is due
  const v1 = await path.post(`/orders/${order.id}/release`);
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  assert.equal(v1.body.version, 1);
  assert.equal(v1.body.clinical_status, 'final');
  assert.equal(v1.body.distribution_status, 'held');
  assert.equal(v1.body.distribution_reason, 'Awaiting payment');
  assert.deepEqual(v1.body.content.tests.map((t: { code: string }) => t.code), ['FBS']);
  assert.deepEqual(v1.body.content.pending.map((t: { code: string }) => t.code), ['LIPID']);

  // Overpaying is refused; settling the bill authorises the held report
  assert.equal((await desk.post(`/orders/${order.id}/payments`, { amount: 900, method: 'cash' })).status, 409);
  const pay2 = await desk.post(`/orders/${order.id}/payments`, { amount: 600, method: 'cash' });
  assert.equal(pay2.body.reports_authorised, 1);
  assert.equal((await path.get(`/reports/${v1.body.id}`)).body.distribution_status, 'authorised');

  // Finish the lipid profile and release again: version 2 supersedes version 1
  await tech.put(`/order-tests/${lipid.id}/results`, { results: [{ parameter_code: 'TG', value: 210 }] });
  await path.post(`/order-tests/${lipid.id}/validate`);
  const v2 = await path.post(`/orders/${order.id}/release`);
  assert.equal(v2.body.version, 2);
  assert.equal(v2.body.supersedes_id, v1.body.id);
  assert.equal(v2.body.clinical_status, 'final');
  assert.equal(v2.body.distribution_status, 'authorised');
  assert.deepEqual(v2.body.content.tests.map((t: { code: string }) => t.code).sort(), ['FBS', 'LIPID']);

  // Correction: reopen, fix, validate; releasing needs an amendment reason
  assert.equal((await tech.put(`/order-tests/${fbs.id}/results`, { results: [{ parameter_code: 'GLU', value: 6.8 }] })).status, 409,
    'released results are locked');
  assert.equal((await path.post(`/order-tests/${fbs.id}/reopen`)).body.status, 'resulted');
  await tech.put(`/order-tests/${fbs.id}/results`, { results: [{ parameter_code: 'GLU', value: 6.8 }] });
  await path.post(`/order-tests/${fbs.id}/validate`);
  assert.equal((await path.post(`/orders/${order.id}/release`)).status, 400);
  const v3 = await path.post(`/orders/${order.id}/release`, { amendment_reason: 'Transcription error' });
  assert.equal(v3.body.version, 3);
  assert.equal(v3.body.clinical_status, 'amended');
  assert.equal(v3.body.amendment_reason, 'Transcription error');

  // The original release is untouched
  const original = await path.get(`/reports/${v1.body.id}`);
  assert.equal(original.body.content.tests[0].results[0].value, '7.2');

  // Daily summary reflects the day's work
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
  const summary = await desk.get(`/summary?date=${today}`);
  assert.equal(summary.body.orders, 1);
  assert.equal(Number(summary.body.collected), 1600);
  assert.equal(summary.body.reports_released, 3);
});

test('without a payment hold, a released report is authorised straight away', async () => {
  const lab = await createTestLab({ holdUntilPaid: false });
  const { order } = await registerAndOrder(lab, 0);
  const fbs = testRow(order, 'FBS');
  await api(lab, lab.reception).post(`/specimens/${fbs.specimen_id}/collect`);
  await api(lab, lab.tech).put(`/order-tests/${fbs.id}/results`, { results: [{ parameter_code: 'GLU', value: 5 }] });
  await api(lab, lab.path).post(`/order-tests/${fbs.id}/validate`);
  const report = await api(lab, lab.path).post(`/orders/${order.id}/release`);
  assert.equal(report.body.distribution_status, 'authorised');
  assert.equal(report.body.content.tests[0].results[0].flag, 'N');
});

test('labs that keep their own billing app get no invoice', async () => {
  const lab = await createTestLab({ billing: false });
  const { order } = await registerAndOrder(lab, 0);
  assert.equal(order.invoice, null);
  const res = await api(lab, lab.reception).post(`/orders/${order.id}/payments`, { amount: 100, method: 'cash' });
  assert.equal(res.status, 404);
});

test("one lab's staff cannot see or change another lab's orders", async () => {
  const labA = await createTestLab();
  const labB = await createTestLab();
  const { order } = await registerAndOrder(labA);

  // A lab B session does not work on lab A's URLs.
  const viaA = await app.inject({ method: 'GET', url: `/labs/${labA.labId}/orders/${order.id}`,
    headers: await staffAuth(labB.labId, labB.reception) });
  assert.equal(viaA.statusCode, 403);

  // Lab B staff using their own lab URL cannot find lab A's order.
  assert.equal((await api(labB, labB.reception).get(`/orders/${order.id}`)).status, 404);
  assert.equal((await api(labB, labB.reception).post(`/orders/${order.id}/payments`, { amount: 10, method: 'cash' })).status, 404);
});

test('requests without a session are refused, and bad input is a 400', async () => {
  const lab = await createTestLab();
  const res = await app.inject({ method: 'GET', url: `/labs/${lab.labId}/tests` });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['www-authenticate'], 'Bearer');
  const desk = api(lab, lab.reception);
  assert.equal((await desk.post('/patients', { full_name: 'X' })).status, 400);
  assert.equal((await desk.post('/patients', { full_name: 'X', sex: 'female' })).status, 201);
  const tech = api(lab, lab.tech);
  assert.equal((await tech.post('/patients', { full_name: 'Y', sex: 'male' })).status, 403);
});
