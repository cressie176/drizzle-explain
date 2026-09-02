# drizzle-explain

[![NPM Version](https://img.shields.io/npm/v/drizzle-explain)](https://www.npmjs.com/package/drizzle-explain)
[![CI](https://github.com/cressie176/drizzle-explain/actions/workflows/qa.yml/badge.svg)](https://github.com/cressie176/drizzle-explain/actions/workflows/qa.yml)
[![Node.js](https://img.shields.io/node/v/drizzle-explain)](https://nodejs.org)
[![License](https://img.shields.io/npm/l/drizzle-explain)](LICENSE)
[![Coverage](https://codecov.io/gh/cressie176/drizzle-explain/branch/main/graph/badge.svg)](https://codecov.io/gh/cressie176/drizzle-explain)

Performance-test your [Drizzle ORM](https://orm.drizzle.team/) queries by running them through `EXPLAIN ANALYZE` and asserting the plan is within tolerance, before a bad plan reaches production.

## The Problem

A query can be correct, pass every functional test, and still be a latent outage.

```ts
// finds 10 rows in a table of 5 million
db.select().from(reservations).where(eq(reservations.roomId, roomId));
```

If nobody added an index on `room_id`, PostgreSQL scans all 5 million rows to return 10. It works on your laptop against a handful of seeded rows. It works in the demo. Then a marketing email lands, the query runs a thousand times a second against production volumes, and the database falls over. The plan was wrong the whole time; you just couldn't see it, because your test data was too small and nothing was watching the plan.

## The Solution

`drizzle-explain` runs each query under `EXPLAIN (ANALYZE, FORMAT JSON)` inside a transaction that is always rolled back, then checks the plan against a set of hardware-independent signals:

- **cost**: the optimizer's own estimate of how expensive the plan is. A missing index shows up as a cost blowout.
- **row-estimate tolerance**: how far the optimizer's row estimates are from reality. Bad estimates are what cause bad plans; catching them catches the *cause*, not just the symptom.
- **disallowed operations**: the plan can be failed outright if it contains an operation you never want to see, such as a sequential scan. Off by default.

```ts
import { createExplain } from 'drizzle-explain';
import { postgresDriver } from 'drizzle-explain/postgres';

const explain = createExplain(postgresDriver(pool), { maxCost: 100, rowEstimateTolerance: 10 });

const analysis = await explain((db) => findReservationsByRoom(db, roomId));

assert.ok(analysis.passed, analysis.message);
```

When the plan is within tolerance, `passed` is `true`. When it isn't, `message` is a human-readable plan tree with the offending nodes annotated, so the assertion failure tells you exactly where the query went wrong.

The query runs against your real schema and (ideally) production-shaped data, but never commits: the transaction is rolled back whether the query reads or writes. Nothing to clean up.

Your callback sees the query's real results, so code that reads the rows it fetched behaves exactly as it does in production (see [Transparent execution](#transparent-execution)).

## Installation

```sh
npm install --save-dev drizzle-explain
```

`drizzle-orm` is a peer dependency; `drizzle-explain` uses the Drizzle instance you already have. It has no other production dependencies and does not bundle a database client; you bring your own (`pg`, `mysql2`, …) and hand it to the driver.

## Quick Start

Write your queries as functions that take a Drizzle database and return a Drizzle query. This is good practice regardless; it keeps persistence logic testable and free of connection concerns.

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

`explain` injects a database instance into your callback, runs the query it returns through `EXPLAIN ANALYZE`, and hands you back the analysis. Your query function is unchanged: in production it takes the real Drizzle instance; under test it takes the one `drizzle-explain` supplies, which returns the same rows the real one would.

## Relational queries

If your query uses Drizzle's relational query builder — `db.query.<table>.findMany(...)` and friends, rather than `db.select()` — the database instance needs to know your schema and relations, exactly as the real one does. Pass the same config you pass to `drizzle()` as the driver's second argument, and `drizzle-explain` builds the instrumented database with it:

```ts
import { createExplain } from 'drizzle-explain';
import { postgresDriver } from 'drizzle-explain/postgres';
import * as schema from './schema.ts';

const explain = createExplain(postgresDriver(pool, { schema }), { maxCost: 100 });

const analysis = await explain((db) => db.query.rooms.findMany({ with: { reservations: true } }));
```

The config accepts whatever `drizzle()` accepts (`schema`, `relations`, `casing`, …), and on drizzle 1.0 you pass `{ relations }` built with `defineRelations`, just as you do for the real instance. To type the callback's `db`, parameterize the driver — `postgresDriver<MyDatabase>(pool, { relations })` — and `db.query` is typed to your schema; it defaults to the untyped database otherwise. A callback that only uses the core query builder needs no config, so the argument is optional and existing calls are unaffected.

## API

### createExplain(driver, defaults?)

Creates an `explain` function bound to a driver and a set of default limits.

- **driver**: a database-specific driver (see [Drivers](#drivers)), e.g. `postgresDriver(pool)`.
- **defaults**: `{ maxCost?, rowEstimateTolerance?, disallowOperations?, allowOperations? }`, applied to every query unless overridden per call. `drizzle-explain` ships no built-in defaults; you decide what "acceptable" means for your application (see [Choosing limits](#choosing-limits)).

### explain(fn, options?)

Runs the query returned by `fn` through `EXPLAIN ANALYZE` and returns an analysis.

- **fn**: `(db) => query`. Receives an instrumented Drizzle database and returns a single Drizzle query, or, when checking several statements, issues them sequentially or concurrently (see [Multiple statements](#multiple-statements)).
- **options**: `{ statements?, limits? }`.
  - **statements**: how many statements `fn` is expected to execute. A positive integer, defaulting to 1 or, when `limits` is an array, to that array's length.
  - **limits**: `{ maxCost?, rowEstimateTolerance?, disallowOperations?, allowOperations? }`, merged over the defaults for this call only; or an array of those, one per statement. To permit an operation your default bans for one specific query, pass `{ allowOperations: [{ operation: Operation.SEQ_SCAN, maxScanned: 500 }] }`; it lifts *only* that operation's ban, only on the nodes matching the conditions, and leaves the rest of the default `disallowOperations` list intact (see [disallowOperations](#disallowoperations)).

Called with no options at all, `explain` expects exactly one statement. If `fn` runs zero or more than one, it throws: a single query is the unit of measurement. To check a function that legitimately issues several, say how many with `statements` (see [Multiple statements](#multiple-statements)).

> **Deprecated since 1.2.0.** Earlier releases took the limits themselves as the second argument: `explain(fn, { maxCost: 200 })` for one statement and `explain(fn, [{ ... }, { ... }])` for several. Both still work and still return what they always did, so nothing needs changing today, but they will be removed in 2.0. Move them under `limits`, and give the array form an explicit `statements` count while you are there.

Omitting `limits` checks every statement against the defaults. Supplying both `statements` and an array of `limits` states the same count twice, which is allowed as long as they agree; if they disagree, or if one set of limits is offered for more than one statement, `explain` throws before running anything, because the mistake is in the test rather than in the code under test.

Called with no options, or with the deprecated bare limits, returns:

```ts
interface Analysis {
  passed: boolean;   // true if every checked signal is within its limit
  message: string;   // "" when passed; otherwise the annotated plan tree
  limits: {          // the effective limits after merging overrides
    maxCost?: number;
    rowEstimateTolerance?: number;
    disallowOperations?: Operation[];
    allowOperations?: (Operation | OperationExemption)[];
  };
  plan: object;      // the raw, unmodified EXPLAIN output from the database
}

interface OperationExemption {
  operation: Operation;   // the ban being lifted
  relation?: string;      // only on nodes reading this table
  maxScanned?: number;    // only on nodes reading at most this many rows
  maxActualRows?: number; // only on nodes producing at most this many rows
}
```

`explain` never throws on a failing plan and never asserts; it reports. You assert, with the test framework and style you prefer:

```ts
assert.ok(analysis.passed, analysis.message);
```

`message` is empty on success. On failure it is a multi-line rendering of the plan with the offending nodes marked, suitable for printing straight into an assertion failure:

```
✘ cost 62431 exceeds limit 100

Seq Scan on reservations  (cost=62431 estimated=10 actual=10 scanned=240000 time=181.4ms)  ✘ cost 62431 > 100
```

The raw plan is always available in `analysis.plan` if you want to log or inspect the full detail; it is the database's native EXPLAIN output, unmodified.

Called with an options object, `explain` returns the aggregate `MultiStatementAnalysis` instead, whatever the count (see [Multiple statements](#multiple-statements)). `passed` and `message` are on both shapes, so the assertion you write is the same either way.

The `✘` markers are printed in red on an interactive terminal, and left uncoloured when output is piped or `CI` is set. Most test runners (including `node --test`) capture the subprocess stdout, which hides the terminal from the renderer and disables colour; set `FORCE_COLOR=1` to force it back on, or `NO_COLOR=1` to turn it off everywhere. The plain text is identical either way, so assertions never depend on colour.

### Multiple statements

Sometimes the thing you want to performance-test isn't a single query: a public function calls a private helper that queries, or fetches a row and then fetches its children. Say how many statements you expect and `explain` checks every one the callback issues:

```ts
const analysis = await explain((db) => findRoomAvailability(db, 42), { statements: 2 });

assert.ok(analysis.passed, analysis.message);
```

Every statement is checked against the defaults, which is often all you want. When a particular statement needs its own allowance, pass an **array** of limits and `explain` pairs them with the statements **by execution order**:

```ts
const analysis = await explain((db) => findRoomAvailability(db, 42), {
  statements: 2,
  limits: [
    { maxCost: 100 }, // the lookup in the private helper
    {
      maxCost: 500, // the availability query itself
      allowOperations: [{ operation: Operation.SEQ_SCAN, relation: 'rooms', maxScanned: 500 }],
    },
  ],
});
```

Each entry merges over the defaults independently, exactly as a single override does, so `{}` means "defaults only, no exception for this statement". `statements` may be omitted when the array already gives the count, and the array may be omitted when the defaults suffice, but one set of limits can never govern several statements: three different queries deserve three considered entries, so write `limits: [{ ... }, {}, {}]` rather than hoping one allowance fits all.

The count is a **contract on how many statements run**. If the callback issues more or fewer, `explain` throws naming both numbers, so an accidental extra query (a helper that grew a second lookup, an N+1 introduced by a refactor) fails the test rather than slipping through unmeasured. This is the whole reason the count is written down rather than inferred: per-statement limits can never catch an N+1, because each of its queries is individually cheap. Only the number gives it away. An empty array of limits, and a `statements` count of zero, are both rejected: asserting that a function makes no queries isn't what `explain` is for.

Whenever you pass `options`, the return value is an aggregate rather than a single `Analysis`, including when the count is one. A `{ statements: 1 }` call still gets the aggregate shape, so a table-driven test that varies the count gets the same shape back on every row:

```ts
interface MultiStatementAnalysis {
  passed: boolean;      // true only if every statement is within its limits
  message: string;      // "" when all passed; otherwise the failing statements
  statements: Analysis[]; // one Analysis per statement, each with its own limits and plan
}
```

`passed` and `message` mean the same as they do for a single statement, so the assertion you write is identical. The message names each failing statement by position, SQL, and the parameters it actually ran with, including values derived from an earlier statement's results:

```
statement 2 of 2
  sql: select "id", "name" from "rooms" where "hotel_id" = $1
  params: [17]

✘ cost 62431 exceeds limit 100

Seq Scan on rooms  (cost=62431 estimated=10 actual=10 scanned=240000 time=181.4ms)  ✘ cost 62431 > 100
```

Statements that passed are left out of the message entirely.

A statement that fails is reported however the failure reaches you. If the error escapes your callback, `explain` rejects with it. If your callback **catches** it and carries on, as an upsert-with-fallback or a deliberately abandoned transaction does, the run continues and the statements that did complete are analysed normally: the failure was yours to handle and you handled it. What `explain` will not do is let a failure disappear, so a statement that fails *after* your callback has returned, most often the loser of a `Promise.race`, still rejects the run, because nothing in your code was ever in a position to see it.

Concurrent issuance is safe: the driver serializes statements, so a callback that fires independent queries with `Promise.all` can be tested unmodified. Statements pair with limits in the order they begin executing, which for `Promise.all([...])` is the array order in practice; sequential awaits remain the clearest style because they make that order obvious. If a pairing ever surprises you, the failure message prints each statement's SQL and parameters, so the mismatch is visible rather than silent. A statement started but not awaited, such as the loser of a `Promise.race`, still executes, is still measured, and still counts towards `statements`: production ran it too, and the race only ignored its result. One that *fails* is never measured and so never counted, which is why a changed count is itself a signal.

## What it checks

`drizzle-explain` is database-independent, but not every database exposes the signal each check needs. A check is only applied when its driver can supply the underlying number; where a driver can't, that check is silently skipped rather than failed. The [drivers table](#supported-databases) shows which checks each database supports; read it alongside this section.

### maxCost

The optimizer's estimated total cost for the top of the plan. Cost is in the optimizer's own arbitrary units, so the *absolute* number is only meaningful relative to your schema, but that's exactly what makes it a good tripwire. A query that should use an index and doesn't will cost orders of magnitude more than one that does.

This check requires the database to report a plan cost. PostgreSQL does; not every database does (see the [drivers table](#supported-databases)). Where the driver can't supply a cost, `maxCost` has no effect even if you set it.

### rowEstimateTolerance

The largest factor by which the optimizer's estimated row count diverges from the actual row count, across **every node in the plan**, expressed as `max(estimated, actual) / min(estimated, actual)`. A tolerance of `10` permits estimates that are up to 10× out in either direction.

This matters more than it first appears. The optimizer chooses a plan based on how many rows it *expects* each step to produce. If it expects a step to return 1 row and it actually returns 10,000, it will happily pick a nested loop that is catastrophic at that volume. The bad plan is downstream of the bad estimate, so a large row-estimate divergence is an early warning that a plan is fragile, usually because table statistics are stale or insufficient.

`drizzle-explain` walks the **entire plan tree**, not just the root, because the misestimate that flips a plan is typically a deep node (a scan feeding a join) whose error is washed out by the time it reaches the top. The worst node is the one that matters, and it's the one named in the failure message.

Using a *ratio* rather than absolute counts means proportional data growth doesn't cause churn: as your data grows, estimate and actual scale together and the ratio holds steady. It only moves when the data changes *shape*, which is precisely when plans are at risk of flipping.

A node that produced or estimated zero rows is left out of the comparison entirely, rather than being scored as infinitely wrong, so an empty result never fails the check on its own. The ratio of the nodes that are compared is rounded to a whole number before it is reported.

### disallowOperations

A list of plan operations that should fail the query outright if they appear anywhere in the tree. The classic use is banning sequential/full-table scans on tables you expect to be indexed:

```ts
import { createExplain, Operation } from 'drizzle-explain';

const explain = createExplain(postgresDriver(pool), { disallowOperations: [Operation.SEQ_SCAN] });
```

Where `maxCost` catches an expensive plan indirectly, this catches a specific *kind* of plan directly. A `Seq Scan` on a large table is one of the clearest signs of a missing or unused index, and this lets you assert on it by name rather than inferring it from cost.

Operations are matched on a **normalized category**, not the database's own plan vocabulary, so the same limit works across drivers. The categories are exposed as the `Operation` enum:

| Operation | PostgreSQL | MariaDB |
|---|---|---|
| SEQ_SCAN | Seq Scan | access type ALL or index |
| INDEX_SCAN | Index Scan, Index Only Scan | access type ref, range, eq_ref or const |
| BITMAP_SCAN | Bitmap Heap Scan, Bitmap Index Scan | not reported |
| NESTED_LOOP | Nested Loop | not reported |
| HASH_JOIN | Hash Join | not reported |
| MERGE_JOIN | Merge Join | not reported |
| SORT | Sort | not reported |
| AGGREGATE | Aggregate | not reported |
| OTHER | not reported | not reported |

MariaDB's plans describe how each table is reached rather than naming the join and sort algorithms as separate nodes, so only the two scan categories are classified there. Banning a join or sort operation is therefore a PostgreSQL-only check today; it is not an error on MariaDB, it simply never matches. `OTHER` is declared but no driver assigns it: a node neither driver recognises is left with no operation at all, and an unclassified node is never treated as disallowed.

Like `maxCost`, this check **defaults to off**: with `disallowOperations` unset, no plan is ever rejected on operation type. A node the driver couldn't classify is never treated as disallowed.

### allowOperations

`allowOperations` is the escape hatch for `disallowOperations`. It only ever *lifts* a ban, never adds one: a node breaches when its operation is disallowed and no `allowOperations` entry matches that node. Because every operation is permitted by default, **setting `allowOperations` on its own (with no `disallowOperations`) does nothing**: there is no ban for it to lift. It is meaningful only as a **per-query override** against a `disallowOperations` default.

This solves the awkward case where a global default bans several operations and one query legitimately needs one of them. Without `allowOperations` you'd have to re-declare the whole list minus the one you want; with it you name only the exception:

```ts
// default: ban both across every query
const explain = createExplain(postgresDriver(pool), {
  disallowOperations: [Operation.SEQ_SCAN, Operation.NESTED_LOOP],
});

// this one report genuinely scans a small lookup table, so lift the SEQ_SCAN
// ban on that table alone; NESTED_LOOP stays disallowed for this query, and so
// does a scan of anything else it touches.
const analysis = await explain((db) => summariseGrades(db), {
  limits: { allowOperations: [{ operation: Operation.SEQ_SCAN, relation: 'grades', maxScanned: 500 }] },
});
```

Every such override is a place where someone looked at a plan and consciously accepted a specific operation for a specific query, the same discipline as a per-query `maxCost` override.

#### Scoping an exemption to part of the plan

Naming a bare operation lifts the ban across the whole plan, which is too blunt when a query touches tables of different sizes. A sequential scan is optimal on a 40-row lookup table and a defect on a 20,000-row one, and a join of the two would have to accept or reject both together. An entry carries conditions instead, and exempts only the nodes that satisfy every one of them:

```ts
const explain = createExplain(postgresDriver(pool), {
  disallowOperations: [Operation.SEQ_SCAN],
  allowOperations: [{ operation: Operation.SEQ_SCAN, maxScanned: 500 }],
});
```

```
✘ disallowed operation: Seq Scan on books

Nested Loop  (cost=360.9 estimated=1 actual=1 time=0.627ms)
  Seq Scan on books  (cost=359 estimated=1 actual=1 scanned=20000 time=0.622ms)  ✘ Seq Scan not allowed
  Seq Scan on authors  (cost=1.4 estimated=40 actual=40 scanned=40 time=0.002ms)  ✓ allowed by maxScanned=500
```

The lookup table is exempt and says why; the large table in the same plan still fails.

| Condition | Exempts |
|---|---|
| operation | required on every entry, the operation being lifted |
| relation | only nodes reading the table it names |
| maxScanned | only nodes reading at most that many rows in total, before filtering |
| maxActualRows | only nodes producing at most that many rows per execution, after filtering |

For a scan, `maxScanned` is the size condition you want, because it counts what the node read rather than what survived the filter. A scan of 20,000 rows returning one has `actualRows` of 1, so `maxActualRows` would wave through the very plan you are hunting. `maxActualRows` exists for the operations that read no table at all, joins and sorts, where rows produced is the only size there is:

```ts
allowOperations: [{ operation: Operation.NESTED_LOOP, maxActualRows: 1000 }]
```

`relation` earns its place alongside a size condition rather than being redundant. A threshold is measured against *your test data*, and in a small test database `{ operation: Operation.SEQ_SCAN, maxScanned: 500 }` exempts every scan in the plan, including the table that genuinely needs an index and only looks harmless because you seeded it with 40 rows. Naming the table bounds the exemption to the one you actually inspected, so the strongest form carries both:

```ts
allowOperations: [{ operation: Operation.SEQ_SCAN, relation: 'countries', maxScanned: 500 }]
```

"Allow it on countries, and tell me when countries stops being small." `relation` records which node you vouched for; `maxScanned` records what you assumed when you vouched for it, and withdraws the exemption when the assumption stops holding.

On MariaDB, `relation` carries the alias where a query aliases the table, since MariaDB reports only the one name. Drizzle does not alias plain selects but does alias relational queries and self-joins.

Four details worth knowing:

- A node the driver reported no count for is never exempted by a condition testing that count. The exemption fails closed, because a driver that cannot supply the signal must not silently exempt everything.
- Every entry must name an operation **and** at least one condition. A bare `{ maxScanned: 500 }` would lift every ban at once, and `{ operation: Operation.SEQ_SCAN }` would lift one ban across the whole plan; both are rejected rather than interpreted.
- An entry naming a condition that does not exist is rejected too. A typo such as `maxScannned` would otherwise quietly become an unconditional exemption.
- Exemptions are annotated in the failure message, as above, but a plan where nothing else failed produces no message at all, so an exemption on an otherwise clean plan is not reported.

> **Deprecated: the plan-wide form.** Passing a bare `Operation`, `allowOperations: [Operation.SEQ_SCAN]`, lifts the ban on every matching node in the plan. It still works and will until 2.0, but it widens silently: a query touching one table today carries its exemption onto every table it joins tomorrow, with nothing in the output to say so. Give the entry a condition instead.

### What it does not check

**Execution time is reported in the plan but never asserted.** Wall-clock time depends on hardware, cache state, and concurrent load; it would be flaky in CI and meaninglessly fast on a developer laptop. Cost and row-estimate tolerance are properties of the plan, not the machine, so they're trustworthy anywhere. If you want to eyeball timing, it's in `analysis.plan`; just don't gate on it.

## Choosing limits

`drizzle-explain` deliberately ships no default limits, because a sensible cost ceiling depends entirely on your schema. But the guidance is firm: **set your default `maxCost` low.**

A low default turns the check into a tripwire. Any query whose plan exceeds it stops and demands a human decision: either optimise the query, or explicitly raise the limit for that one query with a comment explaining why. You should *expect* a fair number of per-query overrides; that isn't the check failing, it's the check working. Every override is a place where someone looked at a plan and consciously accepted its cost. The queries you want to catch are the ones nobody looked at.

Set `rowEstimateTolerance` loosely at first: real optimizer estimates are routinely a few times out even on healthy plans, and multi-join queries legitimately compound estimation error up the tree. Start around `10`, and tighten toward the smallest value that doesn't produce noise. Its job is to catch *gross* misestimation from bad statistics, not to demand a perfect planner.

## Testing every query

`explain` checks one query. To make sure *no* query escapes checking, drive it from a single map of query name to the arguments and options it should be tested with, and add one test that fails if any exported query is missing from the map. The queries themselves stay free of any test concerns.

```ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as reservations from './reservations.ts';

// Each query is either tested with representative arguments and (optional)
// options, or explicitly skipped with a reason. A query that appears in the
// module but not here fails the coverage test below, so it can't be silently
// untested.
const THRESHOLDS: Record<keyof typeof reservations, Case[]> = {
  findReservationsByRoom: [
    { run: (db) => reservations.findReservationsByRoom(db, 42), options: { limits: { maxCost: 200 } } },
  ],
  occupancyByHotel: [
    // Peak vs shoulder season: selectivity differs, so test both.
    { run: (db) => reservations.occupancyByHotel(db, 3, '2025-07-01', '2025-07-31') },
    { run: (db) => reservations.occupancyByHotel(db, 3, '2025-11-01', '2025-11-30'), options: { limits: { rowEstimateTolerance: 50 } } },
  ],
  // Fetches the hotel, then its rooms: two statements, both on the defaults.
  roomsByHotel: [{ run: (db) => reservations.roomsByHotel(db, 3), options: { statements: 2 } }],
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
        const analysis = await explain(c.run, c.options ?? { statements: 1 });
        assert.ok(analysis.passed, analysis.message);
      }
    });
  }
});
```

This pattern lives in *your* test, not in the library, because every test framework expresses iteration and nesting differently. The important properties are that the map of what-gets-tested is data you can read at a glance, and that a query added to the codebase without a corresponding entry fails the build.

> A future release will provide optional `onSuite`/`onTest` hooks to reduce this boilerplate while staying framework-agnostic. The pattern above works today and will keep working.

## Getting realistic data

**This is the part that determines whether any of it means anything.** A query plan is only as representative as the data it ran against. The optimizer chooses plans from the *shape* of your data (how many distinct values a column has, which values are common, how rows correlate), not just the row count. Run `EXPLAIN ANALYZE` against a hundred uniformly-random rows and you'll get plans that have nothing to do with production. The missing index that scans 5 million rows looks free against 100.

So the goal is a test database whose **volume and distribution approximate production**: roughly the right number of rows, and roughly the right skew (some values common, some rare; seasonal peaks; realistic fan-out between related tables).

Database-agnostic ways to get there, cheapest first:

1. **[drizzle-seed](https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-seed)**: generate shaped data directly from your Drizzle schema, with weighted distributions and one-to-many fan-out. Lowest barrier to entry; see the [worked example](#hotel-chain) below.
2. **[drizzle-super-seed](https://www.npmjs.com/package/drizzle-super-seed)**: for larger datasets, generate the rows as bulk SQL files (PostgreSQL `COPY` blocks, with MariaDB and CSV equivalents) straight from the same Drizzle schema, reproducibly from a seed, and load those. Bulk-loading is dramatically faster than row-by-row inserts, and its drift checks fail the build when a table or column is added without a generation rule.
3. **Bake the loaded database into a Docker image**: build the data once, freeze it into an image, and start a disposable container per test run. Everyone gets an identical, instant, production-shaped database with no per-run seeding cost.

Then reach for **database-specific** levers to make the build faster and the plans more faithful. On PostgreSQL, for example:

- **`UNLOGGED` tables** during the load skip the write-ahead log, making bulk seeding substantially faster. (Set them back to `LOGGED`, or accept that the data doesn't survive a crash, which is fine for a disposable test database.)
- **`VACUUM (ANALYZE, FREEZE)`** after loading. `ANALYZE` gathers the statistics the optimizer relies on; *without this step your plans are based on nothing and the whole exercise is void*. `FREEZE` stops PostgreSQL rewriting tuples later for transaction-ID wraparound, which keeps a baked image's files stable.

These are illustrative; every database has its own equivalents. The principle is universal: **get the volume and distribution right, and make sure the optimizer's statistics are current**, or the plans you're asserting on aren't the plans production will use.

## Worked examples

The [`hotel-chain`](examples/hotel-chain) example models one hotel booking system and performance-tests it against both databases from a single npm workspace, seeded by either drizzle-seed or drizzle-super-seed. All four packages share a domain, a seeding shape, and the `THRESHOLDS`-map test pattern; only the connection, the dialect-specific schema and the seeding path differ:

| Example | Database | Seeding | Seed time |
|---|---|---|---|
| [hotel-chain/drizzle-seed-postgres](examples/hotel-chain/drizzle-seed-postgres) | PostgreSQL | drizzle-seed | 14.6 s |
| [hotel-chain/super-seed-postgres](examples/hotel-chain/super-seed-postgres) | PostgreSQL | drizzle-super-seed | 3.1 s |
| [hotel-chain/drizzle-seed-mariadb](examples/hotel-chain/drizzle-seed-mariadb) | MariaDB | drizzle-seed | 8.7 s |
| [hotel-chain/super-seed-mariadb](examples/hotel-chain/super-seed-mariadb) | MariaDB | drizzle-super-seed | 6.0 s |

Seed times are wall-clock for the identical dataset (5 chains, 102 hotels, 18,321 rooms, 1,007,892 reservations) on the same machine, covering generation and load. The gap favours drizzle-super-seed most on PostgreSQL, where the load goes through COPY; it widens further as volumes grow.

### hotel-chain

It models a hotel booking system (`chain → hotel → room → reservation`) seeded to a production-like shape with drizzle-seed or drizzle-super-seed, and performance-tests a handful of representative queries against both PostgreSQL and MariaDB.

The schema skews room grades (most rooms `standard`, few `penthouse`) and concentrates reservations in summer, so date-range and grade predicates have realistically different selectivity, which is what makes the optimizer's plan choices interesting to test.

```ts
// seed.ts: shape the data, don't just fill it
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

> **A note on drizzle-seed and scale.** drizzle-seed populates data using batched multi-row `INSERT`s, not PostgreSQL's `COPY`. That makes it wonderfully convenient (it works straight from your schema with no extra tooling) but noticeably slower for large datasets; in informal testing, `COPY` was roughly **4× faster per row**. For the volumes in this example it's fine. When you outgrow it, [drizzle-super-seed](https://www.npmjs.com/package/drizzle-super-seed) generates bulk SQL files directly from the same Drizzle schema; the [super-seed packages](examples/hotel-chain) cut the seed of the identical million-row dataset from 14.6 to 3.1 seconds on PostgreSQL and from 8.7 to 6.0 seconds on MariaDB.

## Drivers

The mechanism is general: wrap the query in a transaction, ask the database to `EXPLAIN ANALYZE` it, translate the database's plan into a common shape, check the limits, roll back. Only two pieces are database-specific: the exact `EXPLAIN` syntax, and the structure of the plan the database returns. Both live entirely inside a driver.

A driver's only job is to run the right `EXPLAIN`, execute the statement, and translate the result into a normalized plan node:

```ts
interface PlanNode {
  type: string;              // vendor label, e.g. "Seq Scan", "Nested Loop"
  operation?: Operation;     // normalized category for disallowOperations
  relation?: string;         // table the node reads, where it reads one
  alias?: string;            // the query's alias for it, where it differs
  cost?: number;             // optimizer's estimated cost
  estimatedRows?: number;    // optimizer's estimated row count
  actualRows?: number;       // rows the node actually produced, per execution
  scanned?: number;          // rows it read across every execution, before filtering
  loops?: number;            // times the node ran, where the database reports it
  actualTimeMs?: number;     // reported, never asserted
  children: PlanNode[];
}
```

The core walks that normalized tree and never sees a vendor-specific plan key, so support for a new database is a new driver, not a change to the engine.

`relation` and `scanned` are what make a failure legible. Without them a plan joining two tables reports two identical `Seq Scan` lines, and the metrics actively mislead, because `estimatedRows` and `actualRows` are both counts of rows *produced*, after filtering. A scan that reads 20,000 rows to return one shows `estimated=1 actual=1`, which looks smaller than the harmless 40-row lookup table beside it. `scanned` is the count *before* filtering, so the waste a scan does is `scanned` minus the rows it produced, and the two being equal is the signature of a scan throwing nothing away:

```
✘ disallowed operation: Seq Scan on books

Nested Loop  (cost=360.9 estimated=1 actual=1 time=0.668ms)
  Seq Scan on books  (cost=359 estimated=1 actual=1 scanned=20000 time=0.663ms)  ✘ Seq Scan not allowed
  Seq Scan on authors  (cost=1.4 estimated=40 actual=40 scanned=40 time=0.002ms)
```

Both are supplied only where the database reports them. PostgreSQL gives the table and its alias separately, so an aliased scan renders as `Seq Scan on books b`; MariaDB reports only the alias once a query uses one, so `relation` carries whichever name it gave and `alias` stays unset.

Both databases report a node's row counts **per execution**, and a node on the inner side of a nested loop runs once per outer row. `estimatedRows` and `actualRows` are therefore per execution, which is what `rowEstimateTolerance` wants, since it compares them against each other. `scanned` is the odd one out: it is a **total across every execution**, because the question it answers, is this table small enough that reading it is fine, is about the whole query rather than one pass. `loops` carries the count where the database reports it, and the renderer shows it when it is greater than one, so a line reading `scanned=20000 actual=100 loops=200` explains itself:

```
Seq Scan on inners  (cost=31 estimated=2000 actual=100 scanned=20000 loops=200)  ✘ Seq Scan not allowed
```

Without the multiplication a `maxScanned` of 500 would exempt that node, which reads 20,000 rows to produce 100. An unindexed scan on the inner side of a nested loop is the pathology the check exists to catch, so `scanned` counts the work actually done.

The two databases count rows differently, and the driver reconciles them. PostgreSQL reports produced counts directly and the rows a filter discarded alongside, so `scanned` is their sum. MariaDB reports *read* counts (`rows`, `r_rows`) with the proportion surviving the filter as a separate percentage (`filtered`, `r_filtered`), so the driver multiplies the two to get the produced counts and keeps the raw read count as `scanned`, rounding to whole rows. Where a plan reports no percentage the raw counts stand. The effect is that `estimatedRows` and `actualRows` mean the same thing on both drivers, which also lets `rowEstimateTolerance` see a MariaDB optimizer that misjudged a filter's selectivity rather than only one that misjudged a table's size. `type` keeps the database's own label for rendering; `operation` is the driver's mapping of that node onto the normalized [`Operation`](#disallowoperations) category the `disallowOperations` check tests against (left unset where the driver can't classify it). The raw, untranslated plan is preserved in `analysis.plan` because that's the format you already know how to read.

### Transparent execution

Because your callback may consume the rows its query returned (processing the results, deriving a second query's parameters from them, or branching on how many came back), `drizzle-explain` executes each statement for real, not just under `EXPLAIN`. There is no single-execution shortcut: neither PostgreSQL's `EXPLAIN (ANALYZE, FORMAT JSON)` nor MariaDB's `ANALYZE FORMAT=JSON` returns the query's rows, only its plan. So every statement runs twice inside the rolled-back transaction, bracketed by a savepoint so its effects land exactly once:

```
SAVEPOINT drizzle_explain
EXPLAIN ANALYZE <statement>       -- effects happen, plan captured
ROLLBACK TO SAVEPOINT             -- effects undone
<statement>                       -- real execution, real rows returned
```

Statements are serialized within a run: if the callback issues queries concurrently, each one's sandwich completes before the next begins, so the savepoints can never interleave and only one query is ever in flight on the connection. The plan is therefore measured against exactly the state the real execution sees, and the callback receives exactly the rows production would. Two consequences are worth knowing:

- Each statement executes twice, so a run takes roughly twice as long as the query itself.
- Anything not covered by transactional rollback happens twice, most commonly sequence advancement, so an auto-generated id may jump by two per inserted row. Nothing is committed either way.

### Transactions

Query functions that group their writes in a transaction work unchanged:

```ts
await explain((db) =>
  db.transaction(async (tx) => {
    await tx.insert(shoots).values(shoot).returning();
    await tx.insert(photos).values(rows);
  }),
);
```

Every statement inside the callback is explained exactly as it would be outside one. The instrumented database implements `transaction` with a savepoint rather than `BEGIN`, since the run is already inside a transaction that is always rolled back:

```
SAVEPOINT drizzle_explain_tx_1
<statements of the transaction callback, each explained and executed>
RELEASE SAVEPOINT drizzle_explain_tx_1     -- callback returned
ROLLBACK TO SAVEPOINT drizzle_explain_tx_1 -- callback threw
```

The semantics you get are the ones you wrote. `tx.rollback()` throws `TransactionRollbackError` and undoes the transaction's writes, and any other error does the same before propagating, so the state the rest of your callback sees is the state production would present. Nested transactions take a savepoint of their own, so rolling an inner one back leaves the enclosing one's writes in place. Nothing commits either way: the outer rollback discards the lot when the run finishes.

A transaction you abandon is yours to handle: catch the rejection and the run carries on, with the statements that did complete analysed normally, whether the failure came from `tx.rollback()`, from an error your callback threw, or from a statement of its own such as a duplicate key.

Two limits are worth knowing:

- The transaction config (isolation level, `readOnly`) is accepted and ignored. There is only one real transaction, opened by the driver, and its isolation is the connection's.
- Concurrent top-level transactions cannot be isolated from each other. Everything in a run shares one connection, so two transactions started under `Promise.all` interleave on that connection rather than running independently as they would against a pool.

### Supported databases

|                        | PostgreSQL                 | MariaDB                   |
|------------------------|----------------------------|---------------------------|
| Import                 | drizzle-explain/postgres   | drizzle-explain/mariadb   |
| rowEstimateTolerance   | ✓                          | ✓                         |
| maxCost                | ✓                          | ✓                         |
| disallowOperations     | ✓                          | scan categories only      |

Both databases expose the signals `drizzle-explain` needs, though MariaDB classifies only the two scan categories (see the [operation table](#disallowoperations)), so banning a join or sort operation never matches there. PostgreSQL's `EXPLAIN (ANALYZE, FORMAT JSON)` and MariaDB's `ANALYZE FORMAT=JSON` each report estimated rows, actual rows, and a plan cost. MariaDB carries a per-node `cost` on the query block and its access nodes (verified against MariaDB 11.8), so `maxCost` is enforced on both. A trivial `const` primary-key lookup is the one case where MariaDB omits a cost; there the analyser simply skips `maxCost` rather than failing.

### Why not SQLite

SQLite can't be supported, and it's worth being clear about why. `drizzle-explain` works by comparing the optimizer's cost and row *estimates* against reality. SQLite's `EXPLAIN QUERY PLAN` doesn't produce those numbers; it describes the plan it chose (which tables, which indexes, in what order) but reports no cost figure and no per-node row estimates or actuals. There's simply nothing to threshold. This isn't a gap we've chosen to leave open; SQLite's optimizer doesn't expose the signals the technique depends on. If you use SQLite, the equivalent discipline is to inspect `EXPLAIN QUERY PLAN` output for unexpected full-table scans by eye.

## License

MIT
