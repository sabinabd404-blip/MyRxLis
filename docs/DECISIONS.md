# Design decisions

Decisions carried over from the MyRx LIS / Lab Connect / DX planning work.
Each one is enforced in the database where possible, with a test that proves it.

| ID | Decision | Where it is enforced |
| --- | --- | --- |
| D1 | MyRx LIS and MyRx Lab Connect are separate products on one platform. Installing MyRx LIS is never a condition for connecting a lab to MyRx EMR. | Architecture |
| D2 | Every row belongs to exactly one lab, and cannot point at another lab's patients, tests, orders or staff. | Composite `(id, lab_id)` foreign keys; `test/db/tenancy.test.ts` |
| D3 | A result is stored only for a parameter of the test that was ordered, with the reference range copied at entry time. | `results` foreign keys; `test/db/results.test.ts` |
| D4 | An ordered test moves through fixed steps: ordered → collected → in progress → resulted → validated → released. Cancelling needs a reason. | `trg_order_test_transition` |
| D5 | Three statuses stay separate: the test's operational status, the report's clinical status, and its distribution authorisation. Payment status can feed the lab's release policy but never replaces it. | `order_tests.status`, `reports.clinical_status`, `reports.distribution_status`, `invoices`/`payments` |
| D6 | Results lock once validated. A released report is never edited or deleted; corrections create a new version that supersedes it, with a reason. Only distribution authorisation may change after release. | `trg_result_editable`, `trg_protect_released_report`; `test/db/reports.test.ts` |
| D7 | Billing is built into LIS Lite but can be switched off per lab (`labs.billing_enabled`) for labs that keep their own billing app. Holding reports until paid is a per-lab policy (`labs.hold_report_until_paid`). | `lis.labs` |
| D8 | A retried DX order cannot create a duplicate LIS order. | Unique `(lab_id, source, external_ref)`; `test/db/tenancy.test.ts` |
| D9 | Every change to patients, orders, tests, specimens, results, billing and reports is audited with the acting user, and the audit trail is append-only. | `lis.write_audit_event`, `trg_audit_append_only`; `test/db/audit.test.ts` |
| D10 | Stack: PostgreSQL 16, Node.js 22 with TypeScript, Fastify, React for web screens; one modular monolith. | `package.json` |
| D11 | Applied migrations are never edited; changes go in a new numbered migration. | `scripts/migrate.ts` checksum check |
