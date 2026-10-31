import { after } from 'node:test';
import pg from 'pg';
import { loadConfig } from '../../src/config.js';

export const pool = new pg.Pool({ connectionString: loadConfig().testDatabaseUrl, max: 4 });
after(() => pool.end());

/** Run a test body in a transaction that is always rolled back. */
export async function inTx(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Expect `sql` to be rejected by the database. Runs inside a savepoint so
 * the surrounding test transaction stays usable. Returns the error so the
 * caller can check which rule fired.
 */
export async function expectReject(
  c: pg.PoolClient,
  sql: string,
  params: unknown[] = [],
  match?: RegExp,
): Promise<pg.DatabaseError> {
  await c.query('SAVEPOINT expect_reject');
  try {
    await c.query(sql, params);
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT expect_reject');
    const dbErr = err as pg.DatabaseError;
    if (match && !match.test(`${dbErr.message} ${dbErr.constraint ?? ''}`)) {
      throw new Error(`Rejected for the wrong reason: ${dbErr.message} (constraint ${dbErr.constraint ?? '-'})`);
    }
    return dbErr;
  }
  await c.query('ROLLBACK TO SAVEPOINT expect_reject');
  throw new Error(`Expected the database to reject: ${sql}`);
}

async function one<T = Record<string, unknown>>(c: pg.PoolClient, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await c.query(sql, params);
  return rows[0] as T;
}

export interface Fixture {
  labId: string;
  staffId: string;
  pathologistId: string;
  patientId: string;
  testId: string;
  paramId: string;
  orderId: string;
  orderTestId: string;
}

/** A lab with one staff member, a patient, a one-parameter test and an order for it. */
export async function makeFixture(c: pg.PoolClient, code = 'LAB1'): Promise<Fixture> {
  const { id: labId } = await one<{ id: string }>(c,
    `INSERT INTO lis.labs (code, name) VALUES ($1, $2) RETURNING id`, [code, `Lab ${code}`]);
  const { id: staffId } = await one<{ id: string }>(c,
    `INSERT INTO lis.staff_users (lab_id, username, full_name, role)
     VALUES ($1, 'tech', 'Technologist', 'technologist') RETURNING id`, [labId]);
  const { id: pathologistId } = await one<{ id: string }>(c,
    `INSERT INTO lis.staff_users (lab_id, username, full_name, role)
     VALUES ($1, 'path', 'Pathologist', 'pathologist') RETURNING id`, [labId]);
  const { id: patientId } = await one<{ id: string }>(c,
    `INSERT INTO lis.patients (lab_id, patient_code, full_name, sex)
     VALUES ($1, 'P-0001', 'Test Patient', 'female') RETURNING id`, [labId]);
  const { id: testId } = await one<{ id: string }>(c,
    `INSERT INTO lis.tests (lab_id, code, name, specimen_type, price)
     VALUES ($1, 'FBS', 'Fasting blood sugar', 'serum', 200) RETURNING id`, [labId]);
  const { id: paramId } = await one<{ id: string }>(c,
    `INSERT INTO lis.test_parameters (test_id, code, name, result_type, unit, decimals)
     VALUES ($1, 'GLU', 'Glucose', 'numeric', 'mmol/L', 1) RETURNING id`, [testId]);
  const { id: orderId } = await one<{ id: string }>(c,
    `INSERT INTO lis.orders (lab_id, order_number, patient_id, patient_age_days)
     VALUES ($1, 'ORD-0001', $2, 12775) RETURNING id`, [labId, patientId]);
  const { id: orderTestId } = await one<{ id: string }>(c,
    `INSERT INTO lis.order_tests (lab_id, order_id, test_id, price)
     VALUES ($1, $2, $3, 200) RETURNING id`, [labId, orderId, testId]);
  return { labId, staffId, pathologistId, patientId, testId, paramId, orderId, orderTestId };
}

/** Move an ordered test through the normal path up to `target`. */
export async function advanceTest(c: pg.PoolClient, orderTestId: string, target: string): Promise<void> {
  const path = ['ordered', 'collected', 'in_progress', 'resulted', 'validated', 'released'];
  const { rows: [row] } = await c.query('SELECT status FROM lis.order_tests WHERE id = $1', [orderTestId]);
  const start = path.indexOf(row.status) + 1;
  if (start === 0 || path.indexOf(target) < start) throw new Error(`Cannot advance from ${row.status} to ${target}`);
  for (const status of path.slice(start)) {
    await c.query('UPDATE lis.order_tests SET status = $2 WHERE id = $1', [orderTestId, status]);
    if (status === target) return;
  }
}
