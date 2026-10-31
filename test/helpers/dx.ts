import type pg from 'pg';

async function id(c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await c.query(sql, params);
  return (rows[0] as { id: string }).id;
}

export interface DxFixture {
  orgA: string; branchA: string; orgB: string; branchB: string;
  testGlu: string; testCrea: string;
  offerAGlu: string; offerACrea: string; offerBGlu: string;
  patient: string; otherPatient: string; encounter: string;
  order: string; itemGlu: string; itemCrea: string;
  userA: string;
}

/**
 * Two labs (A offers glucose and creatinine, B offers glucose), one patient
 * with an encounter, and one order with a glucose item and a creatinine item.
 */
export async function makeDxFixture(c: pg.PoolClient): Promise<DxFixture> {
  const org = (code: string) => id(c,
    `INSERT INTO organisations (organisation_code, legal_name, display_name, organisation_type)
     VALUES ($1, $1, $1, 'diagnostic_centre') RETURNING id`, [code]);
  const branch = (orgId: string) => id(c,
    `INSERT INTO branches (organisation_id, branch_code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id`, [orgId]);
  const test = (code: string) => id(c,
    `INSERT INTO catalogue_tests (canonical_code, display_name) VALUES ($1, $1) RETURNING id`, [code]);
  const offer = (orgId: string, branchId: string, testId: string, local: string) => id(c,
    `INSERT INTO lab_service_offers (organisation_id, branch_id, catalogue_test_id, local_test_code, local_test_name)
     VALUES ($1, $2, $3, $4, $4) RETURNING id`, [orgId, branchId, testId, local]);
  const patientRef = (value: string) => id(c,
    `INSERT INTO patient_identity_refs (identity_system, identity_value) VALUES ('urn:test', $1) RETURNING id`, [value]);

  const orgA = await org('T-LAB-A'); const branchA = await branch(orgA);
  const orgB = await org('T-LAB-B'); const branchB = await branch(orgB);
  const testGlu = await test('T-GLU'); const testCrea = await test('T-CREA');
  const offerAGlu = await offer(orgA, branchA, testGlu, 'A-GLU');
  const offerACrea = await offer(orgA, branchA, testCrea, 'A-CREA');
  const offerBGlu = await offer(orgB, branchB, testGlu, 'B-GLU');
  const patient = await patientRef('P-1');
  const otherPatient = await patientRef('P-2');
  const encounter = await id(c,
    `INSERT INTO encounters (source_system, source_encounter_id, patient_identity_ref_id)
     VALUES ('myrx-emr', 'E-1', $1) RETURNING id`, [patient]);
  const order = await id(c,
    `INSERT INTO diagnostic_orders (order_number, source_system, source_order_id, patient_identity_ref_id, encounter_id, status)
     VALUES ('DX-T-1', 'myrx-emr', 'O-1', $1, $2, 'submitted') RETURNING id`, [patient, encounter]);
  const item = (line: number, testId: string) => id(c,
    `INSERT INTO diagnostic_order_items (order_id, line_number, catalogue_test_id, requested_test_name)
     VALUES ($1, $2, $3, 'test') RETURNING id`, [order, line, testId]);
  const itemGlu = await item(1, testGlu);
  const itemCrea = await item(2, testCrea);
  const userA = await id(c, `INSERT INTO users (display_name) VALUES ('Lab A operator') RETURNING id`);
  return { orgA, branchA, orgB, branchB, testGlu, testCrea, offerAGlu, offerACrea, offerBGlu,
    patient, otherPatient, encounter, order, itemGlu, itemCrea, userA };
}

export async function assign(
  c: pg.PoolClient, itemId: string, offerId: string, orgId: string, branchId: string,
  attempt = 1, status = 'offered',
): Promise<string> {
  return id(c,
    `INSERT INTO assignment_attempts (order_item_id, lab_service_offer_id, organisation_id, branch_id, attempt_number, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [itemId, offerId, orgId, branchId, attempt, status]);
}

export async function resultSet(c: pg.PoolClient, assignmentId: string, key: string): Promise<string> {
  return id(c,
    `INSERT INTO result_sets (assignment_attempt_id, source_system, idempotency_key, status)
     VALUES ($1, 'lab-a-lis', $2, 'final') RETURNING id`, [assignmentId, key]);
}

export async function reportVersion(
  c: pg.PoolClient, assignmentId: string, version: number,
  opts: { resultSetId?: string; supersedes?: string; status?: string } = {},
): Promise<string> {
  return id(c,
    `INSERT INTO report_versions (assignment_attempt_id, result_set_id, version_number, report_status,
                                  storage_object_key, supersedes_report_version_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [assignmentId, opts.resultSetId ?? null, version, opts.status ?? 'final', `reports/${assignmentId}/v${version}.pdf`,
      opts.supersedes ?? null]);
}
