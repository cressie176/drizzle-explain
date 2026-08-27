# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `explain` accepts an **array of limits**, one per statement, so a callback that issues several queries can be performance-tested. This covers a public function calling a private helper, or a fetch followed by a dependent fetch. Limits are paired with statements by execution order, and each entry merges over the defaults independently ([#16](https://github.com/cressie176/drizzle-explain/issues/16)).
- The array length doubles as a contract on how many statements run. A callback that issues more or fewer than there are entries fails with an error naming both numbers, so an accidental extra query, such as an N+1 introduced by a refactor, is caught rather than going unmeasured ([#16](https://github.com/cressie176/drizzle-explain/issues/16)).
- `MultiStatementAnalysis`, returned by the array form: `passed`, `message`, and one `Analysis` per statement, each with its own limits and raw plan. `passed` and `message` mean what they always did, so the assertion you write is unchanged ([#16](https://github.com/cressie176/drizzle-explain/issues/16)).
- Failure messages for the array form name each failing statement by position, SQL, and the parameters it actually ran with, including values derived from an earlier statement's results. Passing statements are omitted ([#16](https://github.com/cressie176/drizzle-explain/issues/16)).
- `ExplainedStatement` records the `sql` and `params` each statement ran with ([#15](https://github.com/cressie176/drizzle-explain/issues/15)).

### Changed

- **Statements now execute for real.** Previously the drivers ran each statement under `EXPLAIN` only and handed the callback empty rows, so code that consumed its own results saw nothing: derived parameters were empty and branches took the wrong path, making the measured plans unfaithful. Each statement now runs twice inside the always-rolled-back transaction, once under `EXPLAIN ANALYZE` for the plan and once for real for the rows, bracketed by a savepoint so its effects land exactly once ([#15](https://github.com/cressie176/drizzle-explain/issues/15)).

  Two consequences follow from the double execution. A run takes roughly twice as long as the query itself, and anything outside transactional rollback happens twice, most commonly sequence advancement, so an auto-generated id may jump by two per inserted row. Nothing is committed either way.

- The `Driver` contract now requires `sql` and `params` on every `ExplainedStatement`. This is a type-level break for third-party driver implementations; the bundled PostgreSQL and MariaDB drivers are unaffected ([#15](https://github.com/cressie176/drizzle-explain/issues/15)).

## 1.0.0 - 2026-08-23

First stable release. No functional change from 0.1.1.

### Added

- Coverage reporting and published status badges.
- Documentation of the renderer's colour behaviour under `NO_COLOR`, `FORCE_COLOR`, and `CI`.

## 0.1.1 - 2026-08-23

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

[Unreleased]: https://github.com/cressie176/drizzle-explain/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cressie176/drizzle-explain/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/cressie176/drizzle-explain/releases/tag/v0.1.1
