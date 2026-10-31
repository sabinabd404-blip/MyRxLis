import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

export interface DxWorld {
  tag: string;
  clinic: string; clinician: string;
  otherClinic: string; otherClinician: string;
  labA: string; labAUser: string; labB: string; labBUser: string;
  glu: string; crea: string;
  offerAGlu: string; offerACrea: string; offerBGlu: string; offerBCrea: string;
}

/** A committed DX setup with unique codes: two clinics, two labs, two investigations. */
export async function createDxWorld(): Promise<DxWorld> {
  const tag = randomUUID().slice(0, 8);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const one = async (sql: string, p: unknown[]) => (await c.query(sql, p)).rows[0].id as string;
    const org = (code: string, type: string) => one(
      `INSERT INTO organisations (organisation_code, legal_name, display_name, organisation_type)
       VALUES ($1, $1, $1, $2) RETURNING id`, [`${code}-${tag}`, type]);
    const branch = (orgId: string) => one(
      `INSERT INTO branches (organisation_id, branch_code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id`, [orgId]);
    const member = async (orgId: string, role: string) => {
      const userId = await one(`INSERT INTO users (display_name) VALUES ($1) RETURNING id`, [`${role} ${tag}`]);
      await c.query(`INSERT INTO organisation_memberships (organisation_id, user_id, role_code) VALUES ($1, $2, $3)`,
        [orgId, userId, role]);
      return userId;
    };
    const test = (code: string, name: string) => one(
      `INSERT INTO catalogue_tests (canonical_code, display_name, specimen_type) VALUES ($1, $2, 'Serum') RETURNING id`,
      [`${code}-${tag}`, name]);
    const offer = (orgId: string, branchId: string, testId: string, local: string, price: number) => one(
      `INSERT INTO lab_service_offers (organisation_id, branch_id, catalogue_test_id, local_test_code, local_test_name, price_amount)
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`, [orgId, branchId, testId, local, price]);

    const clinic = await org('CLINIC', 'clinic');
    const otherClinic = await org('CLINIC2', 'clinic');
    const labA = await org('LABA', 'diagnostic_centre'); const branchA = await branch(labA);
    const labB = await org('LABB', 'laboratory'); const branchB = await branch(labB);
    const glu = await test('GLU', 'Glucose (fasting)');
    const crea = await test('CREA', 'Serum creatinine');
    const world: DxWorld = {
      tag, clinic, otherClinic, labA, labB, glu, crea,
      clinician: await member(clinic, 'clinician'),
      otherClinician: await member(otherClinic, 'clinician'),
      labAUser: await member(labA, 'lab_operator'),
      labBUser: await member(labB, 'lab_operator'),
      offerAGlu: await offer(labA, branchA, glu, 'A-GLU', 200),
      offerACrea: await offer(labA, branchA, crea, 'A-CREA', 400),
      offerBGlu: await offer(labB, branchB, glu, 'B-GLU', 180),
      offerBCrea: await offer(labB, branchB, crea, 'B-CREA', 350),
    };
    await c.query('COMMIT');
    return world;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
