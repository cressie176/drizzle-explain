import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generate, createPostgresSqlStreamSink } from 'drizzle-super-seed';
import { connect } from './connect.ts';
import { counts, rules } from './rules.ts';
import * as schema from './schema.ts';

const DDL = `
  DROP TABLE IF EXISTS reservations, rooms, hotels, chains CASCADE;

  CREATE TABLE chains (
    id serial PRIMARY KEY,
    name text NOT NULL
  );

  CREATE TABLE hotels (
    id serial PRIMARY KEY,
    chain_id integer NOT NULL REFERENCES chains(id),
    name text NOT NULL
  );

  CREATE TABLE rooms (
    id serial PRIMARY KEY,
    hotel_id integer NOT NULL REFERENCES hotels(id),
    number integer NOT NULL,
    grade text NOT NULL
  );

  CREATE TABLE reservations (
    id serial PRIMARY KEY,
    room_id integer NOT NULL REFERENCES rooms(id),
    guest_name text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL
  );

  CREATE INDEX hotels_chain_id_idx ON hotels (chain_id);
  CREATE INDEX rooms_hotel_id_idx ON rooms (hotel_id);
  CREATE INDEX rooms_grade_idx ON rooms (grade);
  CREATE INDEX reservations_room_id_idx ON reservations (room_id);
  CREATE INDEX reservations_start_date_idx ON reservations (start_date);
`;

const COMPOSE_FILE = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url));

// The generated SQL uses COPY ... FROM stdin, which only psql can execute.
// Use psql from the PATH when available, honouring the standard PG* variables;
// otherwise fall back to the psql inside the repo's compose service.
function resolvePsql() {
  if (isOnPath('psql')) return { command: 'psql', args: ['-v', 'ON_ERROR_STOP=1'], env: psqlEnvironment() };
  return {
    command: 'docker',
    args: ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'drizzle_explain', '-d', 'drizzle_explain'],
    env: process.env,
  };
}

function isOnPath(command: string) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function psqlEnvironment() {
  return {
    ...process.env,
    PGHOST: process.env.PGHOST ?? 'localhost',
    PGPORT: process.env.PGPORT ?? '5432',
    PGUSER: process.env.PGUSER ?? 'drizzle_explain',
    PGPASSWORD: process.env.PGPASSWORD ?? 'drizzle_explain',
    PGDATABASE: process.env.PGDATABASE ?? 'drizzle_explain',
  };
}

async function streamSeedIntoPsql() {
  const psql = resolvePsql();
  const load = spawn(psql.command, psql.args, { env: psql.env, stdio: ['pipe', 'ignore', 'inherit'] });

  const report = await generate({ schema, rules, counts, seed: 1 }, createPostgresSqlStreamSink({ writable: load.stdin }));

  load.stdin.end();
  const code = await new Promise((resolve) => load.on('close', resolve));
  if (code !== 0) throw new Error(`psql exited with code ${code}`);
  return report;
}

async function run() {
  const pool = connect();

  console.log('[1/2] Recreating tables…');
  await pool.query(DDL);
  await pool.end();

  console.log('[2/2] Generating with drizzle-super-seed and streaming into psql…');
  const report = await streamSeedIntoPsql();

  console.log('Seed complete:', { seed: report.seed, rowCounts: report.rowCounts, durationMs: report.durationMs });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
