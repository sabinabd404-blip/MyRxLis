# MyRx DX schema (to be imported)

The MyRx Diagnostic Exchange database foundation (v0.1, built on PostgreSQL 16 as
`myrx_dx_dev`) will be brought in here as numbered migrations in `db/migrations/`,
placed **before** the LIS migrations, together with its existing test scripts
(`test_report_lifecycle.sql`, `test_assignment_lifecycle.sql`) converted to
automated tests under `test/dx/`.

DX tables live in the `public` schema; LIS tables live in the `lis` schema, so the
two never collide. `lis.labs.dx_organisation_id` will link a lab to its DX
organisation once both are present.

Known follow-up for DX: add report-release authorisation fields so the clinical
status, distribution authorisation and payment status stay separate (see
`docs/DECISIONS.md`, D5).
