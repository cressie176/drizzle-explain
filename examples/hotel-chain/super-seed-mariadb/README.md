# hotel-chain-super-seed-mariadb

The MariaDB bulk-load package of the hotel-chain example. See the [shared README](../README.md) for what the example demonstrates and how to run it; the domain, queries, limits and testing pattern are identical to [drizzle-seed-mariadb](../drizzle-seed-mariadb).

What differs is the seeding path. This package generates the dataset with [drizzle-super-seed](https://www.npmjs.com/package/drizzle-super-seed) as extended-INSERT SQL files and loads them through the mariadb client, cutting the seed of the same million-reservation dataset from 8.7 to 6.0 seconds on one measured machine:

1. `rules.ts` declares one generation rule per column and the bimodal parent-child counts, mirroring the drizzle-seed shape so the plans are comparable. The rules are checked against the schema, so adding a table or column without a rule fails the typecheck.
2. `seed.ts` recreates the tables, runs `generate` with `createMariaDbSqlFileSink` into a temporary directory, then streams the numbered files through the mariadb client, which splits statements itself and so never hits the server's max_allowed_packet. It uses a client from your PATH when present (honouring `MARIADB_HOST` and friends), and otherwise falls back to the client inside the repo's compose service, so no local install is needed. One consequence: with `MARIADB_HOST` and friends pointing at a remote database, a local client is required, because the fallback client only reaches the compose service.
3. The generated finalise file runs ANALYZE TABLE so the optimizer has current statistics; InnoDB advances AUTO_INCREMENT past the loaded ids by itself.

Seeding is deterministic: `seed: 1` produces the identical dataset every run, and the same seed produces the same row counts in the PostgreSQL package.
