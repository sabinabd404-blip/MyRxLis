# MyRx LIS

Laboratory information system (MyRx LIS) and diagnostic-order exchange (MyRx DX)
for DHESTRA HealthTech. One codebase and one PostgreSQL database serve both:
LIS tables live in the `lis` schema, DX tables in `public`.

- Plan and phases: [docs/ROADMAP.md](docs/ROADMAP.md)
- Design decisions and where each is enforced: [docs/DECISIONS.md](docs/DECISIONS.md)

## Requirements

- Node.js 22+
- PostgreSQL 16

## Getting started

```bash
npm install
cp .env.example .env        # then edit DATABASE_URL / TEST_DATABASE_URL
npm run db:reset            # create the dev database and apply migrations
npm run db:seed             # load synthetic LIS and DX demo data
npm run dev                 # API on http://localhost:3000 (GET /health)
```

On Windows PowerShell, set variables for the session instead of using `.env`:

```powershell
$env:DATABASE_URL = "postgres://postgres:YOURPASSWORD@localhost:5432/myrxlis_dev"
$env:TEST_DATABASE_URL = "postgres://postgres:YOURPASSWORD@localhost:5432/myrxlis_test"
```

## Signing in

**LIS staff** sign in per lab and send the session token on every request:

```
POST /labs/:labId/auth/login   {"username": "reception", "password": "..."}
→ {"token": "mrxs_...", "expires_at": "...", "staff": {...}}

Authorization: Bearer mrxs_...
```

A session lasts one lab shift (`SESSION_HOURS`, default 12) and only works for
the lab that issued it. Five wrong passwords lock the account for 15 minutes
(an admin reset unlocks it). Other routes: `POST /auth/logout`, `GET /auth/me`,
`PUT /auth/password` (change your own; signs out your other sessions) and
`PUT /staff/:staffId/password` (admin only; signs that person out everywhere).

**Systems calling MyRx DX** (the MyRx EMR, a lab's own LIS) send an API key:
`Authorization: Bearer mrxk_...`. A key belongs to one user in one organisation
and acts with that user's current roles. Organisation admins manage keys at
`/dx/orgs/:orgId/api-keys`.

Passwords are stored as scrypt hashes; session tokens and API keys only as
SHA-256 hashes. Sign-ins, lock-outs, password changes and key changes are
recorded in the append-only `auth_events` table.

First passwords and keys come from the command line (uses `DATABASE_URL`):

```bash
echo 'a strong password' | npm run auth -- set-password DEMO admin
npm run auth -- create-api-key MYRX-DEMO-CHAMBER demo-clinician-001 "MyRx EMR dev"
npm run auth -- list-api-keys MYRX-DEMO-CHAMBER
npm run auth -- revoke-api-key MYRX-DEMO-CHAMBER mrxk_XXXXXXXX
```

The demo seed has no passwords; set them with the first command.

## MyRx DX exchange API

How MyRx EMR sends orders and receives results, and how labs work their queue:
see [docs/DX_API.md](docs/DX_API.md).

## LIS Lite API

All routes sit under `/labs/:labId` and need a staff session (see *Signing in*).

| Method | Path | Who |
| --- | --- | --- |
| POST | `/patients` | receptionist, admin |
| GET | `/patients?q=` | any staff |
| GET | `/tests` | any staff |
| POST | `/orders` | receptionist, admin |
| GET | `/orders/:orderId` | any staff |
| POST | `/orders/:orderId/payments` | receptionist, admin |
| POST | `/specimens/:specimenId/collect` | receptionist, technologist, admin |
| POST | `/specimens/:specimenId/receive` | technologist, pathologist, admin |
| PUT | `/order-tests/:orderTestId/results` | technologist, pathologist |
| POST | `/order-tests/:orderTestId/validate` | pathologist |
| POST | `/order-tests/:orderTestId/reopen` | pathologist |
| POST | `/order-tests/:orderTestId/cancel` | receptionist, pathologist, admin |
| POST | `/orders/:orderId/release` | pathologist |
| GET | `/reports/:reportId` | any staff |
| GET | `/summary?date=YYYY-MM-DD` | any staff |
| GET | `/dx/inbox` | any staff (lab connected to DX) |
| POST | `/dx/import` | receptionist, admin |

For a lab connected to MyRx DX (`lis.labs.dx_organisation_id`), releasing a report sends
the results of DX orders back to DX automatically, and paying a bill passes the release on.

## Tests

```bash
npm test          # recreates the test database, applies migrations, runs all tests
npm run check     # typecheck + tests (what CI runs)
```

Database tests run each case inside a transaction that is rolled back, and check
that each integrity rule rejects bad data for the right reason.

## Layout

```
db/migrations/   numbered SQL migrations (never edit one after it is applied)
db/seeds/        synthetic demo data
db/dx/           where the MyRx DX schema came from and what is still open
scripts/         migrate and seed commands
src/             API (Fastify + TypeScript)
test/db/         LIS database integrity tests
test/dx/         MyRx DX database tests
test/api/        API tests
docs/            roadmap and decisions
```
