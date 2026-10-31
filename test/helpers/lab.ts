import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

export interface TestLab {
  labId: string;
  reception: string; tech: string; path: string;
  fbs: string; lipid: string;
}

/** A committed lab with staff and two tests, unique per call so API tests never collide. */
export async function createTestLab(opts: { holdUntilPaid?: boolean; billing?: boolean } = {}): Promise<TestLab> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const code = `T-${randomUUID().slice(0, 8)}`;
    const { rows: [lab] } = await c.query(
      `INSERT INTO lis.labs (code, name, billing_enabled, hold_report_until_paid) VALUES ($1, $1, $2, $3) RETURNING id`,
      [code, opts.billing ?? true, opts.holdUntilPaid ?? true]);
    const staff = async (username: string, role: string) => (await c.query(
      `INSERT INTO lis.staff_users (lab_id, username, full_name, role) VALUES ($1, $2, $2, $3) RETURNING id`,
      [lab.id, username, role])).rows[0].id as string;
    const test = async (code: string, name: string, specimen: string, price: number) => (await c.query(
      `INSERT INTO lis.tests (lab_id, code, name, specimen_type, price) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [lab.id, code, name, specimen, price])).rows[0].id as string;
    const param = async (testId: string, code: string, unit: string, low: number | null, high: number | null, sort: number) => {
      const { rows: [p] } = await c.query(
        `INSERT INTO lis.test_parameters (test_id, code, name, result_type, unit, sort_order)
         VALUES ($1, $2, $2, 'numeric', $3, $4) RETURNING id`, [testId, code, unit, sort]);
      await c.query('INSERT INTO lis.reference_ranges (parameter_id, low, high) VALUES ($1, $2, $3)', [p.id, low, high]);
    };
    const fbs = await test('FBS', 'Fasting blood sugar', 'Fluoride plasma', 200);
    await param(fbs, 'GLU', 'mmol/L', 3.9, 5.5, 1);
    const lipid = await test('LIPID', 'Lipid profile', 'Serum', 1500);
    await param(lipid, 'CHOL', 'mg/dL', null, 200, 1);
    await param(lipid, 'TG', 'mg/dL', null, 150, 2);
    const result = {
      labId: lab.id as string,
      reception: await staff('reception', 'receptionist'),
      tech: await staff('tech', 'technologist'),
      path: await staff('path', 'pathologist'),
      fbs, lipid,
    };
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
