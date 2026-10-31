import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';
import { pool } from '../helpers/db.js';

test('GET /health reports the database and latest migration', async () => {
  const app = buildApp({ db: pool });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.match(body.schema, /^\d{4}_.+\.sql$/);
  await app.close();
});
