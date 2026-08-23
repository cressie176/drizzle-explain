# hotel-chain-drizzle-seed-maria

A complete, runnable [`drizzle-explain`](../..) example on **MariaDB**, mirroring the PostgreSQL worked example. It models a hotel booking system — `chain → hotel → room → reservation` — seeded to a production-like shape with [drizzle-seed](https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-seed), then performance-tests a handful of representative queries under `ANALYZE FORMAT=JSON` inside an always-rolled-back transaction.

It is the same domain and the same testing pattern as [`hotel-chain-postgres`](../hotel-chain-postgres), carried across to a different database — which is the point: the queries and the coverage-map test are database-agnostic, only the driver and connection change.

## What it demonstrates

- **The `THRESHOLDS`-map coverage pattern.** Every exported query is either tested with representative arguments and limits, or explicitly skipped with a reason. A query added without an entry fails the `every query is tested or skipped` test — nothing can be silently untested.
- **`rowEstimateTolerance` on MariaDB.** MariaDB's `ANALYZE FORMAT=JSON` reports estimated and actual rows per node, so the row-estimate check works exactly as it does on PostgreSQL.
- **`maxCost` on MariaDB.** MariaDB 11.8 exposes a per-node `cost` on scan and join plans, so `maxCost` is enforced on real queries here (see `findReservationsByRoom`, `occupancyByHotel`, the grade and chain-join queries).
- **A deliberate breach.** `reservationsByGuestName` filters an unindexed column with a leading wildcard, forcing a full scan of ~860k reservations. Tested with `maxCost: 1` it **fails**, and the test asserts `passed === false` with a non-empty annotated plan message — so you can see the failure output:

  ```
  ✘ cost 142.39 exceeds limit 1

  Query Block  (cost=142.39 time=162.15ms)  ✘ cost 142.39 > 1
    ALL reservations  (cost=142.39 rows=861595 actual=863670 time=88.23ms)
  ```

- **`maxCost` silently skipped on a `const` primary-key lookup.** `chainById` is a `WHERE id = ?` lookup. MariaDB reports `access_type: const` for it and omits `cost` entirely, so `maxCost` has nothing to check. The test sets `maxCost: 0` — a limit nothing could satisfy — and still asserts `passed === true`, proving the driver **skips** an unavailable signal rather than failing on it. `rowEstimateTolerance` still applies.

## The queries (`queries.ts`)

| Query | Shape | Tested with |
|---|---|---|
| `findReservationsByRoom` | indexed lookup on `reservation.room_id` | `maxCost` |
| `occupancyByHotel` | reservation ⋈ room, date range + hotel; peak vs shoulder season | `maxCost`, `rowEstimateTolerance` |
| `roomsByGrade` | grade index, common (`standard`) vs rare (`penthouse`) | `maxCost` |
| `roomsForChain` | chain ⋈ hotel ⋈ room join | `maxCost` |
| `chainById` | **`const` PK lookup** — `maxCost` skipped, not failed | `maxCost: 0` (skipped) |
| `reservationsByGuestName` | **intentional breach** — unindexed leading-wildcard full scan | `maxCost: 1` (fails) |

## Running it

This example reuses the **root** `docker-compose.yml` MariaDB service (host `127.0.0.1:3306`, database/user/password all `drizzle_explain`). There is no second compose file.

```sh
# 1. From the repository root, start the shared MariaDB (and PostgreSQL) containers:
cd ../..
docker compose up -d
cd examples/hotel-chain-drizzle-seed-maria

# 2. Install dependencies (drizzle-explain is linked via file:../..):
npm install

# 3. Seed the database — drops and recreates the tables, generates shaped
#    data, and runs ANALYZE TABLE so the optimizer's statistics are current:
npm run seed

# 4. Run the performance tests:
npm test
```

Connection settings default to the root compose service and can be overridden with `MARIADB_HOST`, `MARIADB_PORT`, `MARIADB_USER`, `MARIADB_PASSWORD`, `MARIADB_DATABASE`.

## Seeding shape

`seed.ts` uses the same skew as the PostgreSQL example so plans are comparable: 5 chains; hotels split 0.7/0.3 between small and large fan-out; rooms 0.6/0.4; room grades weighted `standard` 0.5, `superior` 0.3, `deluxe` 0.15, `suite`+`penthouse` 0.05; reservations 0.8/0.2 with `startDate` concentrated in summer (`2025-05-01` … `2025-09-30`). After inserting, it runs `ANALYZE TABLE` on every table — **without current statistics the plans you assert on aren't the plans production would use.**

> drizzle-seed populates via batched multi-row `INSERT`s, which is convenient but slower than bulk loading. For the volume here (~860k reservations) it is fine; the seed takes on the order of a minute.
