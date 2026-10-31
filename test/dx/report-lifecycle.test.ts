// Port of test_report_lifecycle.sql (protections 3, 6 and 7 of migration 0003).
import { test } from 'node:test';
import { expectReject, inTx } from '../helpers/db.js';
import { assign, makeDxFixture, reportVersion, resultSet } from '../helpers/dx.js';

test('report lifecycle: link, correct, and protect report versions', () => inTx(async (c) => {
  const f = await makeDxFixture(c);
  const a1 = await assign(c, f.itemGlu, f.offerAGlu, f.orgA, f.branchA, 1, 'accepted');
  const a2 = await assign(c, f.itemCrea, f.offerACrea, f.orgA, f.branchA, 1, 'accepted');
  const rs1 = await resultSet(c, a1, 'k1');
  const rs2 = await resultSet(c, a2, 'k2');

  // A report linked to its own assignment's result set: accepted.
  const v1 = await reportVersion(c, a1, 1, { resultSetId: rs1 });

  // A report linked to another assignment's result set: rejected.
  await expectReject(c,
    `INSERT INTO report_versions (assignment_attempt_id, result_set_id, version_number, report_status, storage_object_key)
     VALUES ($1, $2, 9, 'final', 'x')`, [a1, rs2], /Report rejected/);

  // A corrected report superseding a version of the same assignment: accepted.
  await reportVersion(c, a1, 2, { resultSetId: rs1, supersedes: v1, status: 'corrected' });

  // Superseding a report that belongs to another assignment: rejected.
  await expectReject(c,
    `INSERT INTO report_versions (assignment_attempt_id, version_number, report_status, storage_object_key,
                                  supersedes_report_version_id)
     VALUES ($1, 1, 'corrected', 'y', $2)`, [a2, v1], /report_versions_supersedes_same_assignment_fk/);

  // Existing versions cannot be updated or deleted.
  await expectReject(c, `UPDATE report_versions SET report_status = 'cancelled' WHERE id = $1`, [v1], /immutable/);
  await expectReject(c, `DELETE FROM report_versions WHERE id = $1`, [v1], /immutable/);
}));
