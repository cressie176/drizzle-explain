# drizzle-explain

<!--
[![NPM Version](https://img.shields.io/npm/v/drizzle-explain)](https://www.npmjs.com/package/drizzle-explain)
[![CI](https://github.com/cressie176/drizzle-explain/actions/workflows/qa.yml/badge.svg)](https://github.com/cressie176/drizzle-explain/actions/workflows/qa.yml)
[![Coverage](https://codecov.io/gh/cressie176/drizzle-explain/branch/main/graph/badge.svg)](https://codecov.io/gh/cressie176/drizzle-explain)
[![Node.js](https://img.shields.io/node/v/drizzle-explain)](https://nodejs.org)
[![License](https://img.shields.io/npm/l/drizzle-explain)](LICENSE)
-->

Performance-test your [Drizzle ORM](https://orm.drizzle.team/) queries by running them through `EXPLAIN ANALYZE` and asserting the plan is within tolerance — before a bad plan reaches production.

## The Problem

A query can be correct, pass every functional test, and still be a latent outage.

```ts
// finds 10 rows in a table of 5 million
db.select().from(reservations).where(eq(reservations.roomId, roomId));
```

If nobody added an index on `room_id`, PostgreSQL scans all 5 million rows to return 10. It works on your laptop against a handful of seeded rows. It works in the demo. Then a marketing email lands, the query runs a thousand times a second against production volumes, and the database falls over. The plan was wrong the whole time — you just couldn't see it, because your test data was too small and nothing was watching the plan.

## The Solution

`drizzle-explain` runs each query under `EXPLAIN (ANALYZE, FORMAT JSON)` inside a transaction that is always rolled back, then checks two hardware-independent signals from the plan:

- **cost** — the optimizer's own estimate of how expensive the plan is. A missing index shows up as a cost blowout.
- **row-estimate tolerance** — how far the optimizer's row estimates are from reality. Bad estimates are what cause bad plans; catching them catches the *cause*, not just the symptom.

```ts
import { createExplain } from 'drizzle-explain';
import { postgresDriver } from 'drizzle-explain/postgres';

const explain = createExplain(postgresDriver(pool), { maxCost: 100, rowEstimateTolerance: 10 });

const analysis = await explain((db) => findReservationsByRoom(db, roomId));

assert.ok(analysis.passed, analysis.message);
```

When the plan is within tolerance, `passed` is `true`. When it isn't, `message` is a human-readable plan tree with the offending nodes annotated, so the assertion failure tells you exactly where the query went wrong.

The query runs against your real schema and (ideally) production-shaped data, but never commits — the transaction is rolled back whether the query reads or writes. Nothing to clean up.

## Installation

```sh
npm install --save-dev drizzle-explain
```

`drizzle-orm` is a peer dependency — `drizzle-explain` uses the Drizzle instance you already have. It has no other production dependencies and does not bundle a database client; you bring your own (`pg`, `mysql2`, …) and hand it to the driver.

## Quick Start

Write your queries as functions that take a Drizzle database and return a Drizzle query. This is good practice regardless — it keeps persistence logic testable and free of connection concerns.

```ts
// reservations.ts
export function findReservationsByRoom(db: Db, roomId: number) {
  return db.select().from(reservations).where(eq(reservations.roomId, roomId));
}
```

Then, in a test using whatever framework you prefer:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createExplain } from 'drizzle-explain';
import { postgresDriver } from 'drizzle-explain/postgres';
import { findReservationsByRoom } from './reservations.ts';

const pool = new Pool({ /* connection to your prod-shaped test database */ });
const explain = createExplain(postgresDriver(pool), { maxCost: 100, rowEstimateTolerance: 10 });

test('findReservationsByRoom stays cheap', async () => {
  const analysis = await explain((db) => findReservationsByRoom(db, 42));
  assert.ok(analysis.passed, analysis.message);
});
```

`explain` injects a database instance into your callback, runs the query it returns through `EXPLAIN ANALYZE`, and hands you back the analysis. Your query function is unchanged — in production it takes the real Drizzle instance; under test it takes the one `drizzle-explain` supplies.

## API

### `createExplain(driver, defaults?)`

Creates an `explain` function bound to a driver and a set of default limits.

- **driver** — a database-specific driver (see [Drivers](#drivers)), e.g. `postgresDriver(pool)`.
- **defaults** — `{ maxCost?, rowEstimateTolerance? }`, applied to every query unless overridden per call. `drizzle-explain` ships no built-in defaults; you decide what "acceptable" means for your application (see [Choosing limits](#choosing-limits)).

### `explain(fn, overrides?)`

Runs the query returned by `fn` through `EXPLAIN ANALYZE` and returns an analysis.

- **fn** — `(db) => query`. Receives an instrumented Drizzle database and returns a single Drizzle query.
- **overrides** — `{ maxCost?, rowEstimateTolerance? }`, merged over the defaults for this call only.

Exactly one statement must be executed per call. If `fn` runs zero or more than one statement, `explain` throws — performance-testing a single query is the unit of measurement.

Returns:

```ts
interface Analysis {
  passed: boolean;   // true if every checked signal is within its limit
  message: string;   // "" when passed; otherwise the annotated plan tree
  limits: {          // the effective limits after merging overrides
    maxCost?: number;
    rowEstimateTolerance?: number;
  };
  plan: object;      // the raw, unmodified EXPLAIN output from the database
}
```

`explain` never throws on a failing plan and never asserts — it reports. You assert, with the test framework and style you prefer:

```ts
assert.ok(analysis.passed, analysis.message);
```

`message` is empty on success. On failure it is a multi-line rendering of the plan with the offending nodes marked, suitable for printing straight into an assertion failure:

```
✘ cost 62431 exceeds limit 100

Seq Scan on reservations  (cost=0..62431 rows=10 actual=10)  ✘ cost 62431 > 100
  Filter: (room_id = 42)
```

The raw plan is always available in `analysis.plan` if you want to log or inspect the full detail; it is the database's native EXPLAIN output, unmodified.

## What it checks

`drizzle-explain` is database-independent, but not every database exposes the signal each check needs. A check is only applied when its driver can supply the underlying number; where a driver can't, that check is silently skipped rather than failed. The [drivers table](#supported-databases) shows which checks each database supports — read it alongside this section.

### maxCost

The optimizer's estimated total cost for the top of the plan. Cost is in the optimizer's own arbitrary units, so the *absolute* number is only meaningful relative to your schema — but that's exactly what makes it a good tripwire. A query that should use an index and doesn't will cost orders of magnitude more than one that does.

This check requires the database to report a plan cost. PostgreSQL does; not every database does (see the [drivers table](#supported-databases)). Where the driver can't supply a cost, `maxCost` has no effect even if you set it.

### rowEstimateTolerance

The largest factor by which the optimizer's estimated row count diverges from the actual row count, across **every node in the plan**, expressed as `max(estimated, actual) / min(estimated, actual)`. A tolerance of `10` permits estimates that are up to 10× out in either direction.

This matters more than it first appears. The optimizer chooses a plan based on how many rows it *expects* each step to produce. If it expects a step to return 1 row and it actually returns 10,000, it will happily pick a nested loop that is catastrophic at that volume. The bad plan is downstream of the bad estimate — so a large row-estimate divergence is an early warning that a plan is fragile, usually because table statistics are stale or insufficient.

`drizzle-explain` walks the **entire plan tree**, not just the root, because the misestimate that flips a plan is typically a deep node — a scan feeding a join — whose error is washed out by the time it reaches the top. The worst node is the one that matters, and it's the one named in the failure message.

Using a *ratio* rather than absolute counts means proportional data growth doesn't cause churn: as your data grows, estimate and actual scale together and the ratio holds steady. It only moves when the data changes *shape* — which is precisely when plans are at risk of flipping.

When a node returns zero rows, the ratio is clamped (a divide-by-zero or "infinitely wrong" estimate isn't a useful signal), so an empty result never fails the check on its own.

### What it does not check

**Execution time is reported in the plan but never asserted.** Wall-clock time depends on hardware, cache state, and concurrent load — it would be flaky in CI and meaninglessly fast on a developer laptop. Cost and row-estimate tolerance are properties of the plan, not the machine, so they're trustworthy anywhere. If you want to eyeball timing, it's in `analysis.plan`; just don't gate on it.

## Choosing limits

`drizzle-explain` deliberately ships no default limits — a sensible cost ceiling depends entirely on your schema. But the guidance is firm: **set your default `maxCost` low.**

A low default turns the check into a tripwire. Any query whose plan exceeds it stops and demands a human decision: either optimise the query, or explicitly raise the limit for that one query with a comment explaining why. You should *expect* a fair number of per-query overrides — that isn't the check failing, it's the check working. Every override is a place where someone looked at a plan and consciously accepted its cost. The queries you want to catch are the ones nobody looked at.

Set `rowEstimateTolerance` loosely at first — real optimizer estimates are routinely a few times out even on healthy plans, and multi-join queries legitimately compound estimation error up the tree. Start around `10`, and tighten toward the smallest value that doesn't produce noise. Its job is to catch *gross* misestimation from bad statistics, not to demand a perfect planner.

## Testing every query

`explain` checks one query. To make sure *no* query escapes checking, drive it from a single map of query name to the arguments and limits it should be tested with, and add one test that fails if any exported query is missing from the map. The queries themselves stay free of any test concerns.

```ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as reservations from './reservations.ts';

// Each query is either tested with representative arguments and (optional)
// limit overrides, or explicitly skipped with a reason. A query that appears
// in the module but not here fails the coverage test below — it can't be
// silently untested.
const THRESHOLDS: Record<keyof typeof reservations, Case[]> = {
  findReservationsByRoom: [
    { run: (db) => reservations.findReservationsByRoom(db, 42), limits: { maxCost: 200 } },
  ],
  occupancyByHotel: [
    // Peak vs shoulder season: selectivity differs, so test both.
    { run: (db) => reservations.occupancyByHotel(db, 3, '2025-07-01', '2025-07-31') },
    { run: (db) => reservations.occupancyByHotel(db, 3, '2025-11-01', '2025-11-30'), limits: { rowEstimateTolerance: 50 } },
  ],
  rebuildStatistics: [{ skip: 'VACUUM cannot run inside a transaction' }],
};

describe('query performance', () => {
  test('every query is tested or skipped', () => {
    const untested = Object.keys(reservations).filter((name) => !(name in THRESHOLDS));
    assert.deepEqual(untested, [], `queries missing from THRESHOLDS: ${untested.join(', ')}`);
  });

  for (const [name, cases] of Object.entries(THRESHOLDS)) {
    test(name, async (t) => {
      for (const c of cases) {
        if ('skip' in c) {
          t.skip(c.skip);
          continue;
        }
        const analysis = await explain(c.run, c.limits);
        assert.ok(analysis.passed, analysis.message);
      }
    });
  }
});
```

This pattern lives in *your* test, not in the library, because every test framework expresses iteration and nesting differently. The important properties are that the map of what-gets-tested is data you can read at a glance, and that a query added to the codebase without a corresponding entry fails the build.

> A future release will provide optional `onSuite`/`onTest` hooks to reduce this boilerplate while staying framework-agnostic. The pattern above works today and will keep working.

## Getting realistic data

**This is the part that determines whether any of it means anything.** A query plan is only as representative as the data it ran against. The optimizer chooses plans from the *shape* of your data — how many distinct values a column has, which values are common, how rows correlate — not just the row count. Run `EXPLAIN ANALYZE` against a hundred uniformly-random rows and you'll get plans that have nothing to do with production. The missing index that scans 5 million rows looks free against 100.

So the goal is a test database whose **volume and distribution approximate production**: roughly the right number of rows, and roughly the right skew (some values common, some rare; seasonal peaks; realistic fan-out between related tables).

Database-agnostic ways to get there, cheapest first:

1. **[drizzle-seed](https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-seed)** — generate shaped data directly from your Drizzle schema, with weighted distributions and one-to-many fan-out. Lowest barrier to entry; see the [worked example](#worked-example-a-hotel-chain) below.
2. **Generated SQL loaded with `COPY`** — for larger datasets, generate the rows as a `.sql` file of `COPY` blocks and load that. Bulk-loading is dramatically faster than row-by-row inserts.
3. **Bake the loaded database into a Docker image** — build the data once, freeze it into an image, and start a disposable container per test run. Everyone gets an identical, instant, production-shaped database with no per-run seeding cost.

Then reach for **database-specific** levers to make the build faster and the plans more faithful. On PostgreSQL, for example:

- **`UNLOGGED` tables** during the load skip the write-ahead log, making bulk seeding substantially faster. (Set them back to `LOGGED`, or accept that the data doesn't survive a crash — fine for a disposable test database.)
- **`VACUUM (ANALYZE, FREEZE)`** after loading. `ANALYZE` gathers the statistics the optimizer relies on — *without this step your plans are based on nothing and the whole exercise is void*. `FREEZE` stops PostgreSQL rewriting tuples later for transaction-ID wraparound, which keeps a baked image's files stable.

These are illustrative — every database has its own equivalents. The principle is universal: **get the volume and distribution right, and make sure the optimizer's statistics are current**, or the plans you're asserting on aren't the plans production will use.

## Worked examples

Complete, runnable examples live in [`examples`](examples). Both drizzle-seed examples model the same hotel booking system against different databases; a faster `COPY`-based variant is planned:

| Example | Database | Seeding | Status |
|---|---|---|---|
| [hotel-chain-drizzle-seed-postgres](examples/hotel-chain-drizzle-seed-postgres) | PostgreSQL | drizzle-seed | available |
| [hotel-chain-drizzle-seed-maria](examples/hotel-chain-drizzle-seed-maria) | MariaDB | drizzle-seed | available |
| hotel-chain-copy-postgres | PostgreSQL | generated SQL + COPY | planned |

### hotel-chain-drizzle-seed-postgres

It models a hotel booking system — `chain → hotel → room → reservation` — seeded to a production-like shape with drizzle-seed, and performance-tests a handful of representative queries.

The schema skews room grades (most rooms `standard`, few `penthouse`) and concentrates reservations in summer, so date-range and grade predicates have realistically different selectivity — which is what makes the optimizer's plan choices interesting to test.

```ts
// seed.ts — shape the data, don't just fill it
import { seed } from 'drizzle-seed';
import * as schema from './schema.ts';

await seed(db, schema, { seed: 1 }).refine((f) => ({
  chains: {
    count: 5,
    with: { hotels: [{ weight: 0.7, count: [10, 20] }, { weight: 0.3, count: [30, 50] }] },
  },
  hotels: {
    columns: { name: f.companyName() },
    with: { rooms: [{ weight: 0.6, count: [80, 120] }, { weight: 0.4, count: [200, 400] }] },
  },
  rooms: {
    columns: {
      // Grade skew gives the grade index a realistic distribution.
      grade: f.weightedRandom([
        { weight: 0.5, value: f.valuesFromArray({ values: ['standard'] }) },
        { weight: 0.3, value: f.valuesFromArray({ values: ['superior'] }) },
        { weight: 0.15, value: f.valuesFromArray({ values: ['deluxe'] }) },
        { weight: 0.05, value: f.valuesFromArray({ values: ['suite', 'penthouse'] }) },
      ]),
    },
    with: { reservations: [{ weight: 0.8, count: [20, 60] }, { weight: 0.2, count: [80, 150] }] },
  },
  reservations: {
    columns: {
      // Concentrate stays in summer so date-range selectivity varies by month.
      startDate: f.date({ minDate: '2025-05-01', maxDate: '2025-09-30' }),
    },
  },
}));
```

> **A note on drizzle-seed and scale.** drizzle-seed populates data using batched multi-row `INSERT`s, not PostgreSQL's `COPY`. That makes it wonderfully convenient — it works straight from your schema with no extra tooling — but noticeably slower for large datasets; in informal testing, `COPY` was roughly **4× faster per row**. For the volumes in this example it's fine. When you outgrow it, move to the generated-SQL-plus-`COPY` approach (a second worked example is planned). The Drizzle team is [tracking a request](https://github.com/drizzle-team/drizzle-orm/issues/4133) for drizzle-seed to emit a `seed.sql` file, which would give a faster, file-based path directly from the same schema.

## Drivers

The mechanism is general: wrap the query in a transaction, ask the database to `EXPLAIN ANALYZE` it, translate the database's plan into a common shape, check the limits, roll back. Only two pieces are database-specific — the exact `EXPLAIN` syntax, and the structure of the plan the database returns — and both live entirely inside a driver.

A driver's only job is to run the right `EXPLAIN` and translate the result into a normalized plan node:

```ts
interface PlanNode {
  type: string;              // e.g. "Seq Scan", "Nested Loop"
  cost?: number;             // optimizer's estimated cost
  estimatedRows?: number;    // optimizer's estimated row count
  actualRows?: number;       // rows the node actually produced
  actualTimeMs?: number;     // reported, never asserted
  children: PlanNode[];
}
```

The core walks that normalized tree — it never sees a vendor-specific plan key — so support for a new database is a new driver, not a change to the engine. The raw, untranslated plan is preserved in `analysis.plan` because that's the format you already know how to read.

### Supported databases

|                        | PostgreSQL                 | MariaDB                   |
|------------------------|----------------------------|---------------------------|
| Import                 | drizzle-explain/postgres   | drizzle-explain/mariadb   |
| rowEstimateTolerance   | ✓                          | ✓                         |
| maxCost                | ✓                          | ✓                         |

Both databases expose the signals `drizzle-explain` needs. PostgreSQL's `EXPLAIN (ANALYZE, FORMAT JSON)` and MariaDB's `ANALYZE FORMAT=JSON` each report estimated rows, actual rows, and a plan cost — MariaDB carries a per-node `cost` on the query block and its access nodes (verified against MariaDB 11.8), so `maxCost` is enforced on both. A trivial `const` primary-key lookup is the one case where MariaDB omits a cost; there the analyser simply skips `maxCost` rather than failing.

### Why not SQLite

SQLite can't be supported, and it's worth being clear about why. `drizzle-explain` works by comparing the optimizer's cost and row *estimates* against reality. SQLite's `EXPLAIN QUERY PLAN` doesn't produce those numbers — it describes the plan it chose (which tables, which indexes, in what order) but reports no cost figure and no per-node row estimates or actuals. There's simply nothing to threshold. This isn't a gap we've chosen to leave open; SQLite's optimizer doesn't expose the signals the technique depends on. If you use SQLite, the equivalent discipline is to inspect `EXPLAIN QUERY PLAN` output for unexpected full-table scans by eye.

## License

MIT
