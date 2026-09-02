# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - Unreleased

### Added

- `allowOperations` entries can carry conditions, so an exemption applies to individual plan nodes rather than the whole plan: `allowOperations: [{ operation: Operation.SEQ_SCAN, maxScanned: 500 }]`. A sequential scan is optimal on a small lookup table and a defect on a large one, and a query joining both previously had to accept or reject the pair together. Two conditions are supported, `relation` to name a table and `maxScanned` to set a size above which the exemption lapses, and they combine. Naming a bare operation behaves exactly as before. Exemptions are annotated in the failure message, `✓ allowed by maxScanned=500`, so an exempted scan is visible rather than merely absent, though a plan where nothing else failed still produces no message. A node whose driver reported no `scanned` count is never exempted by `maxScanned`, and an entry naming no operation, or a condition that does not exist, is rejected rather than interpreted.
- `OperationExemption` is exported from the type definitions.
- `PlanNode` carries `relation`, `alias` and `scanned` where the database reports them, and the failure message renders all three. A plan joining two tables previously reported two identical `Seq Scan` lines with nothing to tell them apart, and its metrics misled: `estimatedRows` and `actualRows` both count rows *produced*, so a scan reading 20,000 rows to return one showed `rows=1 actual=1` and looked smaller than the 40-row lookup table beside it. Lines now read `Seq Scan on books  (cost=359 rows=1 actual=1 scanned=20000 time=0.663ms)`, and the summary names the table too. Waste is `scanned` minus `actualRows`; equal values mean the scan threw nothing away. PostgreSQL reports the table and alias separately, so an aliased scan renders as `Seq Scan on books b`; MariaDB reports only the alias once a query uses one, so `relation` carries whichever name it gave.

### Fixed

- A statement error the query callback catches no longer fails the whole explain. The sequencer recorded every failure and rethrew the first when the run drained, regardless of whether the callback had dealt with it, so an upsert-with-fallback or any try/catch around a statement rejected the run even though the callback recovered exactly as it does in production. The transaction support added above made this sharper still: a transaction could roll back correctly, the following statements could run correctly, and the run would then reject anyway. Only failures the callback could not observe, meaning those that settle after it has returned, now fail the run. Errors that escape the callback still reject as before, and so does the loser of a `Promise.race` that fails once the callback has resolved, since nothing was ever in a position to see it.
- MariaDB plans keep the access nodes of joins, `ORDER BY` and `GROUP BY` queries. MariaDB nests those tables under wrapper keys the translator did not recognise (`block-nl-join`, `read_sorted_file`, `filesort`, `temporary_table`), so the nodes never reached the normalized tree and every check that walks it skipped them without a word. A join of a 40-row lookup table and a 5,000-row table under `disallowOperations: [SEQ_SCAN]` reported a single breach, on the 40-row table; the full scan of the larger one was not in the tree at all. `ORDER BY` and `GROUP BY` plans translated to no access node whatsoever. **Like the row-count change above, this can surface breaches that were previously invisible**, and those breaches are real. The union result pseudo-table is still deliberately excluded, since it is a result set rather than a table access.

### Changed

- MariaDB reports `estimatedRows` and `actualRows` as rows *produced*, matching PostgreSQL. Its plans count rows *read* (`rows`, `r_rows`) and report the proportion surviving the filter separately (`filtered`, `r_filtered`), and the driver previously used the read counts directly. A query returning one row out of a 20,000-row scan reported `actualRows` of 20000. The driver now multiplies the counts by their percentages, rounds to whole rows, and keeps the read count as `scanned`; where a plan reports no percentage the raw counts stand. **This makes `rowEstimateTolerance` stricter on MariaDB**, and suites that passed may now fail: comparing two read counts hid every selectivity misestimate, because both sides were the same pre-filter number. A full scan whose filter matched one row of 20,000 gave a ratio of 1.0 and passed; it now reports the optimizer's real error, 19761x. Plans where the optimizer was right, an indexed lookup or an unfiltered scan, are unaffected.
- The rendered estimate is labelled `estimated=` rather than `rows=`. Three row counts now sit on a node line and the old label named neither what it measured nor that it was a prediction, which made `rows=1 actual=1 scanned=20000` hard to read. Every label now states what it is. This changes the text of `analysis.message` only; the `estimatedRows` field is unchanged.
- MariaDB plan nodes no longer concatenate the table name into `type`. A full scan of `widgets` had `type` of `ALL widgets`, where the README defines `type` as the database's own node label; it is now `ALL`, with the name in `relation`. Rendered output changes from `ALL widgets` to `ALL on widgets`, matching PostgreSQL.

## [1.2.0] - 2026-09-02

### Added

- The instrumented database passed to the query callback supports `db.transaction(...)`. Previously it inherited the proxy driver's stub, which threw `Transactions are not supported by the Postgres Proxy driver` (and the MySQL equivalent) before a single statement was explained, so any query function grouping its writes in a transaction could not be tested at all. The driver now implements `transaction` with a savepoint taken inside the rolled-back transaction it already opens, so the callback's statements are explained exactly as they would be outside one. `tx.rollback()` throws `TransactionRollbackError` and undoes the transaction's writes, any other error does the same before propagating, and a nested transaction takes a savepoint of its own so rolling it back leaves the enclosing one's writes in place. The transaction config (isolation level, `readOnly`) is accepted and ignored, since the run's isolation is the connection's. Both drivers behave identically.
- `explain` accepts an **options object** as its second argument: `{ statements?, limits? }`. `statements` states how many statements the callback is expected to execute, so the contract on statement count is written down rather than inferred from the length of a limits array. `limits` takes the same overrides as before, either one set or one per statement.
- `explain(fn, { statements: 3 })` checks all three statements against the defaults, with no need to repeat `[{}, {}, {}]`. This was the friction that motivated the change: previously an array of limits was the only way to admit more than one statement, so a callback issuing several had to spell out an entry per statement even when every entry was empty.
- Supplying `statements` alongside an array of `limits` states the same count twice and is allowed as long as they agree. Where they disagree, or where one set of limits is offered for more than one statement, `explain` throws before executing anything, because the mistake is in the test rather than in the code under test. A `statements` count that is not a positive integer is rejected the same way, matching the existing rejection of an empty limits array.
- `ExplainOptions` is exported from the type definitions.

### Changed

- Any call passing an options object returns a `MultiStatementAnalysis`, including `{ statements: 1 }`. Only `explain(fn)` and the deprecated bare-limits form return a single `Analysis`. This keeps the return shape a property of how the call is written rather than of how many statements happened to run, so a table-driven test that varies the count gets the same shape back on every row. `passed` and `message` are on both shapes, so the assertion you write is unchanged.
- The statement-count mismatch error no longer attributes the expected number to the limits array, since it may now come from `statements`: `explain expected 3 statements but 5 were executed`.
- The single-statement error names the fix: *If this function legitimately issues several, pass `{ statements: n }`, optionally with one set of limits per statement.*

### Deprecated

- Passing limits directly as the second argument, `explain(fn, { maxCost: 200 })` and `explain(fn, [{ ... }, { ... }])`. Both still work, still enforce the same statement counts, and still return what they always did, so no change is required now. Move them under `limits` and give the array form an explicit `statements` count. They will be removed in 2.0.

## [1.1.3] - 2026-09-01

### Added

- `postgresDriver` and `mariadbDriver` accept an optional second argument, the same Drizzle config you pass to `drizzle()` (`schema`, `relations`, `casing`, …). The driver forwards it when constructing the instrumented database, so callbacks that use the relational query builder (`db.query.<table>.findMany(...)`) can be explained. Previously the driver built the database with no config, leaving `db.query` empty, so a relational query threw `Cannot read properties of undefined`. Callbacks that only use the core query builder (`db.select()`, `db.insert()`, …) need no config and are unaffected. The driver is generic over the database type — `postgresDriver<MyDatabase>(pool, { relations })` — so the callback's `db` can be typed to your schema; it defaults to the untyped database, unchanged from before.

## [1.1.2] - 2026-09-01

### Fixed

- The drizzle-orm peer dependency range now admits 1.0.0 pre-releases (`>=0.36 || >=1.0.0-beta.1`), so projects on a drizzle 1.0.0 beta or release candidate install without an ERESOLVE failure. Semver ranges never match pre-release versions, so the previous `>=0.36` made npm reject otherwise-compatible installs. The library needed no code changes: the full test suite passes unchanged against 1.0.0-beta.22 and 1.0.0-rc.4, and fresh installs that do not pin drizzle-orm still resolve the stable release.

## [1.1.1] - 2026-08-28

Examples and documentation only; the published library is unchanged from 1.1.0.

### Added

- Worked examples seeding the hotel-chain dataset with [drizzle-super-seed](https://www.npmjs.com/package/drizzle-super-seed): the identical million-reservation dataset bulk-loads via COPY on PostgreSQL and extended INSERTs on MariaDB, cutting measured seed times from 14.6 to 3.1 seconds and from 8.7 to 6.0 seconds respectively.

### Changed

- The README's guidance on getting realistic data now recommends drizzle-super-seed for bulk seeding and records the measured seed-time comparisons in the worked examples table.

## [1.1.0] - 2026-08-27

### Added

- `explain` accepts an **array of limits**, one per statement, so a callback that issues several queries can be performance-tested. This covers a public function calling a private helper, or a fetch followed by a dependent fetch. Limits are paired with statements by execution order, and each entry merges over the defaults independently ([#16](https://github.com/cressie176/drizzle-explain/issues/16)).
- The array length doubles as a contract on how many statements run. A callback that issues more or fewer than there are entries fails with an error naming both numbers, so an accidental extra query, such as an N+1 introduced by a refactor, is caught rather than going unmeasured ([#16](https://github.com/cressie176/drizzle-explain/issues/16)).
- `MultiStatementAnalysis`, returned by the array form: `passed`, `message`, and one `Analysis` per statement, each with its own limits and raw plan. `passed` and `message` mean what they always did, so the assertion you write is unchanged ([#16](https://github.com/cressie176/drizzle-explain/issues/16)).
- Failure messages for the array form name each failing statement by position, SQL, and the parameters it actually ran with, including values derived from an earlier statement's results. Passing statements are omitted ([#16](https://github.com/cressie176/drizzle-explain/issues/16)).
- `ExplainedStatement` records the `sql` and `params` each statement ran with ([#15](https://github.com/cressie176/drizzle-explain/issues/15)).
- Callbacks that issue statements concurrently are safe. The driver serializes each statement's explain-and-execute sequence within a run and drains in-flight statements before rolling back, so `Promise.all` pairs with limits in array order and a raced statement (`Promise.race`) is still measured and counted. Without this, overlapping statements could interleave their savepoints and silently corrupt the state the plans are measured against ([#17](https://github.com/cressie176/drizzle-explain/issues/17)).

### Changed

- **Statements now execute for real.** Previously the drivers ran each statement under `EXPLAIN` only and handed the callback empty rows, so code that consumed its own results saw nothing: derived parameters were empty and branches took the wrong path, making the measured plans unfaithful. Each statement now runs twice inside the always-rolled-back transaction, once under `EXPLAIN ANALYZE` for the plan and once for real for the rows, bracketed by a savepoint so its effects land exactly once ([#15](https://github.com/cressie176/drizzle-explain/issues/15)).

  Two consequences follow from the double execution. A run takes roughly twice as long as the query itself, and anything outside transactional rollback happens twice, most commonly sequence advancement, so an auto-generated id may jump by two per inserted row. Nothing is committed either way.

- The `Driver` contract now requires `sql` and `params` on every `ExplainedStatement`. This is a type-level break for third-party driver implementations; the bundled PostgreSQL and MariaDB drivers are unaffected ([#15](https://github.com/cressie176/drizzle-explain/issues/15)).

## [1.0.0] - 2026-08-23

First stable release. No functional change from 0.1.1.

### Added

- Coverage reporting and published status badges.
- Documentation of the renderer's colour behaviour under `NO_COLOR`, `FORCE_COLOR`, and `CI`.

## [0.1.1] - 2026-08-23

Initial release.

### Added

- `createExplain(driver, defaults?)` and `explain(fn, overrides?)`, which run a Drizzle query through `EXPLAIN ANALYZE` inside a transaction that is always rolled back, and report whether the plan is within tolerance. Neither throws on a failing plan nor asserts; you assert.
- `maxCost`, which fails a plan whose estimated total cost exceeds the limit.
- `rowEstimateTolerance`, which fails a plan where any node's estimated and actual row counts diverge by more than the given factor, walking the entire tree rather than just the root. Zero-row nodes are clamped so an empty result never fails on its own.
- `disallowOperations` and `allowOperations`, which reject plans containing a named operation, matched on a normalized category rather than the database's own vocabulary, with a per-query escape hatch.
- PostgreSQL driver at `drizzle-explain/postgres`, over `EXPLAIN (ANALYZE, FORMAT JSON)`.
- MariaDB driver at `drizzle-explain/mariadb`, over `ANALYZE FORMAT=JSON`. It supports all three checks; `maxCost` is skipped for a trivial constant primary-key lookup, where MariaDB reports no cost.
- Annotated plan renderer. On failure, `message` is the plan tree with the offending nodes marked, suitable for printing straight into an assertion failure. Breach markers are coloured on an interactive terminal and honour `NO_COLOR`, `FORCE_COLOR`, and `CI`.
- Worked examples under `examples/hotel-chain`, performance-testing one booking domain against both databases from a single npm workspace.

[1.1.3]: https://github.com/cressie176/drizzle-explain/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/cressie176/drizzle-explain/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/cressie176/drizzle-explain/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/cressie176/drizzle-explain/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/cressie176/drizzle-explain/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/cressie176/drizzle-explain/releases/tag/v0.1.1
