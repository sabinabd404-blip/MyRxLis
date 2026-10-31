# MyRx DX schema

The MyRx Diagnostic Exchange database foundation v0.1 (first built by hand on
PostgreSQL 16 as `myrx_dx_dev`) now lives in the numbered migrations:

| Migration | Source |
| --- | --- |
| `0002_dx_foundation.sql` | `schema.sql` from MyRx_DX_Database_Foundation_v0.1, unchanged apart from the outer `BEGIN`/`COMMIT` |
| `0003_dx_integrity_hardening.sql` | `migration_001_integrity_hardening.sql` (six triggers) plus the hand-added `report_versions_supersedes_same_assignment_fk` |
| `0004_dx_assignment_history.sql` | New: closes gaps T3–T6 from the revised assignment lifecycle test |
| `0005_dx_report_release_decisions.sql` | New: append-only lab release decisions, kept separate from report status (decision D5) |

The old `validation.sql`, `test_report_lifecycle.sql` and `test_assignment_lifecycle.sql`
checks are now automated tests in `test/dx/`. The synthetic DX seed is `db/seeds/dx_demo.sql`.

DX tables live in the `public` schema; LIS tables live in `lis`, so they never collide.
`lis.labs.dx_organisation_id` links a lab to its DX organisation.

## Moving your existing `myrx_dx_dev`

Your local `myrx_dx_dev` was built from the same files, so nothing in it needs to be
kept. Create a fresh database with `npm run db:reset` instead of upgrading it.

## Still open (from the v0.1 README)

- Row-level security and API-level access control (API-001, API-005)
- Concurrency test for two simultaneous assignment attempts (API-002)
- Parent-record changes that could invalidate an existing relationship (for example,
  editing a lab offer's test after it has been assigned)
