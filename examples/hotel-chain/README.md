# hotel-chain

A complete, runnable [`drizzle-explain`](../..) example. It models a hotel booking system — `chain → hotel → room → reservation` — seeds it to a production-like shape with [drizzle-seed](https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-seed), and performance-tests a handful of representative queries with `EXPLAIN ANALYZE` inside an always-rolled-back transaction.

The same domain and the same testing pattern run against **both PostgreSQL and MariaDB**, seeded by **two different tools**, as four packages in one npm workspace:

| Package | Database | Seeding | Driver |
|---|---|---|---|
| [`drizzle-seed-postgres`](drizzle-seed-postgres) | PostgreSQL | drizzle-seed | `drizzle-explain/postgres` |
| [`drizzle-seed-mariadb`](drizzle-seed-mariadb) | MariaDB | drizzle-seed | `drizzle-explain/mariadb` |
| [`super-seed-postgres`](super-seed-postgres) | PostgreSQL | drizzle-super-seed | `drizzle-explain/postgres` |
| [`super-seed-mariadb`](super-seed-mariadb) | MariaDB | drizzle-super-seed | `drizzle-explain/mariadb` |

That's the point: the queries and the coverage-map test are database-agnostic, and the seeding tool is interchangeable. Only the connection (`connect.ts`), the dialect-specific schema (`schema.ts`) and the seeding path change between packages. The drizzle-seed pair inserts through the ORM; the [drizzle-super-seed](https://www.npmjs.com/package/drizzle-super-seed) pair generates bulk SQL from the same schema shape and loads the identical million-row dataset in a few seconds.

## What it demonstrates

- **Queries as plain functions.** `queries.ts` exports `(db, ...args) => query` functions with no test or connection concerns, so the same function runs in production and under `explain`.
- **A coverage-enforced test.** `performance.test.ts` drives every query from a single `THRESHOLDS` map and fails if any exported query is missing from it — no query can be silently untested.
- **Shaped data, not just volume.** The seed skews room grades (most `standard`, few `penthouse`) and concentrates reservations in summer, so date-range and grade predicates have realistically different selectivity — which is what makes the optimizer's plan choices interesting to test.
- **A deliberate breach.** An unindexed leading-wildcard name match forces a full scan of the reservations table. Tested with a tiny `maxCost` it **fails**, and the test asserts `passed === false` with a non-empty annotated plan message — living documentation of what a failure looks like.
- **Accepted costs are explicit.** A few genuinely expensive queries (a summer occupancy range, a whole-chain join) carry per-query `maxCost` overrides with a comment. That is the check working, not failing: every override is a place a human looked at the plan and accepted its cost.
- **A signal skipped, not failed (MariaDB).** MariaDB omits a cost for a `const` primary-key lookup, so `maxCost` has nothing to check there. That case sets `maxCost: 0` — a limit nothing could satisfy — and still passes, proving the driver skips an unavailable signal rather than failing on it.

## Running it

Both databases come from the repo-root `docker-compose.yml` — there is no compose file here. PostgreSQL listens on `localhost:5432`, MariaDB on `127.0.0.1:3306`, each with user / password / database all `drizzle_explain`.

```sh
# 1. Start the databases (from the repo root)
npm run db:up            # or: docker compose up -d

# 2. Install the workspace (from this directory)
cd examples/hotel-chain
npm install              # installs all packages via npm workspaces

# 3. Seed with either tool, then test
npm run seed             # drizzle-seed, both databases; or seed:postgres / seed:mariadb
npm run seed:super       # drizzle-super-seed, both databases (seconds rather than minutes)
npm test                 # test everything; or test:postgres / test:super-postgres / ...
```

Both seeding paths populate the same tables with the same shape, so either one satisfies every package's tests. Run whichever you are exploring; the most recent seed wins.

Each `seed` is idempotent — it drops and recreates its own tables, then runs `ANALYZE` so the optimizer's statistics are current. **Without current statistics the optimizer plans against nothing and the whole exercise is void.**

Connection settings can be overridden with the standard environment variables — `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` for PostgreSQL, and `MARIADB_HOST` / `MARIADB_PORT` / `MARIADB_USER` / `MARIADB_PASSWORD` / `MARIADB_DATABASE` for MariaDB.

## Seeding shape

Both packages seed with the same skew so the plans are comparable: 5 chains; hotels split 0.7/0.3 between small and large fan-out; rooms 0.6/0.4; room grades weighted `standard` 0.5, `superior` 0.3, `deluxe` 0.15, `suite`+`penthouse` 0.05; reservations 0.8/0.2 with `startDate` concentrated in summer (`2025-05-01` … `2025-09-30`).

## Files (per package)

| File | Purpose |
|---|---|
| `schema.ts` | Drizzle schema for `chain → hotel → room → reservation`, with the indexes the queries rely on |
| `seed.ts` | Drops/recreates tables, seeds shaped data, refreshes statistics |
| `rules.ts` | (super-seed packages) per-column generation rules and parent-child counts |
| `queries.ts` | Exported query functions under test |
| `performance.test.ts` | Coverage-enforced `THRESHOLDS` map and per-query assertions |
| `connect.ts` | Database connection |

## A note on drizzle-seed and scale

drizzle-seed populates data using batched multi-row `INSERT`s, not a bulk-load path like PostgreSQL's `COPY`. That makes it wonderfully convenient (it works straight from your schema with no extra tooling) but noticeably slower for large datasets. The super-seed packages in this workspace demonstrate the difference on the identical dataset: [drizzle-super-seed](https://www.npmjs.com/package/drizzle-super-seed) generates bulk SQL (COPY for PostgreSQL, extended INSERTs for MariaDB) and loads the million reservations in a few seconds, where drizzle-seed takes a minute or two.
