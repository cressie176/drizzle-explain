import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { Connection } from 'mysql2/promise';
import { generate, createMariaDbSqlFileSink } from 'drizzle-super-seed';
import { connect } from './connect.ts';
import { counts, rules } from './rules.ts';
import * as schema from './schema.ts';

const TABLES = ['reservations', 'rooms', 'hotels', 'chains'] as const;

const COMPOSE_FILE = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url));

async function recreateTables(connection: Connection) {
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of TABLES) await connection.query(`DROP TABLE IF EXISTS ${table}`);
  await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  await createSchema(connection);
}

async function createSchema(connection: Connection) {
  await connection.query(`
    CREATE TABLE chains (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(128) NOT NULL
    )`);
  await connection.query(`
    CREATE TABLE hotels (
      id INT PRIMARY KEY AUTO_INCREMENT,
      chain_id INT NOT NULL,
      name VARCHAR(128) NOT NULL,
      INDEX hotels_chain_id_idx (chain_id),
      FOREIGN KEY (chain_id) REFERENCES chains(id)
    )`);
  await connection.query(`
    CREATE TABLE rooms (
      id INT PRIMARY KEY AUTO_INCREMENT,
      hotel_id INT NOT NULL,
      number VARCHAR(16) NOT NULL,
      grade VARCHAR(16) NOT NULL,
      INDEX rooms_hotel_id_idx (hotel_id),
      INDEX rooms_grade_idx (grade),
      FOREIGN KEY (hotel_id) REFERENCES hotels(id)
    )`);
  await connection.query(`
    CREATE TABLE reservations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      room_id INT NOT NULL,
      guest_name VARCHAR(128) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      INDEX reservations_room_id_idx (room_id),
      INDEX reservations_start_date_idx (start_date),
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    )`);
}

// The generated files are plain SQL, but at this volume a single file exceeds
// the server's max_allowed_packet as one driver query. The mariadb client
// splits statements itself, so stream the files through it: from the PATH
// when available, honouring the standard MARIADB_* variables; otherwise the
// client inside the repo's compose service.
function resolveClient() {
  if (isOnPath('mariadb')) return { command: 'mariadb', args: clientArguments() };
  if (isOnPath('mysql')) return { command: 'mysql', args: clientArguments() };
  return {
    command: 'docker',
    args: ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'mariadb', 'mariadb', '-u', 'drizzle_explain', '-pdrizzle_explain', 'drizzle_explain'],
  };
}

function isOnPath(command: string) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function clientArguments() {
  return [
    '-h',
    process.env.MARIADB_HOST ?? '127.0.0.1',
    '-P',
    process.env.MARIADB_PORT ?? '3306',
    '-u',
    process.env.MARIADB_USER ?? 'drizzle_explain',
    `-p${process.env.MARIADB_PASSWORD ?? 'drizzle_explain'}`,
    process.env.MARIADB_DATABASE ?? 'drizzle_explain',
  ];
}

async function loadFiles(directory: string) {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const client = resolveClient();
  const load = spawn(client.command, client.args, { stdio: ['pipe', 'ignore', 'inherit'] });
  await pipeline(concatenated(directory, files), load.stdin);
  const code = await new Promise((resolve) => load.on('close', resolve));
  if (code !== 0) throw new Error(`${client.command} exited with code ${code}`);
}

async function* concatenated(directory: string, files: string[]) {
  for (const file of files) yield* createReadStream(join(directory, file));
}

async function run() {
  const connection = await connect();

  console.log('[1/3] Recreating tables…');
  await recreateTables(connection);
  await connection.end();

  console.log('[2/3] Generating SQL files with drizzle-super-seed…');
  const directory = await mkdtemp(join(tmpdir(), 'hotel-chain-seed-'));
  const report = await generate({ schema, rules, counts, seed: 1 }, createMariaDbSqlFileSink({ directory }));

  console.log('[3/3] Loading the files through the mariadb client…');
  await loadFiles(directory);

  console.log('Seed complete:', { seed: report.seed, rowCounts: report.rowCounts, durationMs: report.durationMs, directory });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
