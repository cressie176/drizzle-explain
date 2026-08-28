# hotel-chain-super-seed-postgres

The PostgreSQL bulk-load package of the hotel-chain example. See the [shared README](../README.md) for what the example demonstrates and how to run it; the domain, queries, limits and testing pattern are identical to [drizzle-seed-postgres](../drizzle-seed-postgres).

What differs is the seeding path. This package generates the dataset with [drizzle-super-seed](https://www.npmjs.com/package/drizzle-super-seed) and streams it straight into psql as COPY blocks, so the same million-reservation dataset that takes drizzle-seed a minute or two loads in a few seconds:

1. `rules.ts` declares one generation rule per column and the bimodal parent-child counts, mirroring the drizzle-seed shape so the plans are comparable. The rules are checked against the schema, so adding a table or column without a rule fails the typecheck.
2. `seed.ts` recreates the tables, then runs `generate` with `createPostgresSqlStreamSink` piped into a spawned psql. It uses psql from your PATH when present (honouring `PGHOST` and friends), and otherwise falls back to the psql inside the repo's compose service, so no local client install is needed.
3. The generated script makes the tables UNLOGGED for load speed (fine for a disposable test database), advances the sequences past the loaded ids, and finishes with ANALYZE so the optimizer has current statistics.

Seeding is deterministic: `seed: 1` produces the identical dataset every run, and the same seed produces the same row counts in the MariaDB package.
