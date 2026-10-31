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
