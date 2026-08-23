# hotel-chain-drizzle-seed-postgres

A complete, runnable [`drizzle-explain`](../..) example. It models a hotel booking system — `chain → hotel → room → reservation` — seeds it to a production-like shape with [drizzle-seed](https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-seed), and performance-tests a handful of representative queries with `EXPLAIN ANALYZE`.

## What it demonstrates

- **Shaped data, not just volume.** The seed skews room grades (most `standard`, few `penthouse`) and concentrates reservations in summer, so date-range and grade predicates have realistically different selectivity — which is what makes the optimizer's plan choices interesting to test.
- **Queries as plain functions.** [`queries.ts`](queries.ts) exports `(db, ...args) => query` functions with no test or connection concerns, so the same function runs in production and under `explain`.
- **A coverage-enforced test.** [`performance.test.ts`](performance.test.ts) drives every query from a single `THRESHOLDS` map and fails if any exported query is missing from it — no query can be silently untested.
- **A deliberate breach.** `findReservationsByGuest` does an unindexed substring match (`LIKE '%aa%'`), so it blows past the cost limit on purpose. Its case asserts that it *does* breach and that `analysis.message` renders the annotated plan — living documentation of what a failure looks like.
- **Accepted costs are explicit.** A couple of queries (a summer occupancy range, a whole-chain join) are genuinely expensive against this volume, so they carry per-query `maxCost` overrides with a comment. That is the check working, not failing: every override is a place a human looked at the plan and accepted its cost.

## Running it

The PostgreSQL instance from the repo-root `docker-compose.yml` is reused — there is no separate compose file here. It listens on `localhost:5432` with user / password / database all `drizzle_explain`.

```sh
# 1. Start the database (from the repo root)
npm run db:up            # or: docker compose up -d

# 2. Install and seed (from this directory)
cd examples/hotel-chain-drizzle-seed-postgres
npm install
npm run seed             # drops/recreates tables, seeds ~860k reservations, runs ANALYZE

# 3. Run the performance tests
npm test
```

`seed.ts` is idempotent — it drops and recreates its own tables each run, so you can re-seed freely. It runs `ANALYZE;` at the end: **without current statistics the optimizer plans against nothing and the whole exercise is void.** Connection settings can be overridden with the standard `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` environment variables.

## A note on drizzle-seed and scale

drizzle-seed populates data using batched multi-row `INSERT`s, not PostgreSQL's `COPY`. That makes it wonderfully convenient — it works straight from your schema with no extra tooling — but noticeably slower for large datasets; in informal testing, `COPY` was roughly **4× faster per row**. For the volumes in this example (a few hundred thousand rows) it's fine. When you outgrow it, move to a generated-SQL-plus-`COPY` approach. The Drizzle team is [tracking a request](https://github.com/drizzle-team/drizzle-orm/issues/4133) for drizzle-seed to emit a `seed.sql` file, which would give a faster, file-based path directly from the same schema.

## Files

| File | Purpose |
|---|---|
| [`schema.ts`](schema.ts) | Drizzle schema for `chain → hotel → room → reservation`, with the indexes the queries rely on |
| [`seed.ts`](seed.ts) | Drops/recreates tables, seeds shaped data with drizzle-seed, runs `ANALYZE` |
| [`queries.ts`](queries.ts) | Exported query functions under test |
| [`performance.test.ts`](performance.test.ts) | Coverage-enforced `THRESHOLDS` map and per-query assertions |
| [`database.ts`](database.ts) | `pg` connection pool |
