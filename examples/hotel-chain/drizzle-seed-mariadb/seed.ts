import { drizzle } from 'drizzle-orm/mysql2';
import { seed } from 'drizzle-seed';
import type { Connection } from 'mysql2/promise';
import { connect } from './connect.ts';
import * as schema from './schema.ts';

const TABLES = ['reservations', 'rooms', 'hotels', 'chains'] as const;

async function main() {
  const connection = await connect();

  console.log('[1/3] Recreating tables…');
  await recreateTables(connection);

  console.log('[2/3] Seeding data with drizzle-seed — this takes a minute or two, please wait…');
  await seedData(connection);

  console.log('[3/3] Refreshing statistics (ANALYZE TABLE)…');
  await refreshStatistics(connection);

  await connection.end();
  console.log('Seed complete.');
}

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

async function seedData(connection: Connection) {
  const db = drizzle(connection, { schema, mode: 'default' });
  await seed(db, { chains: schema.chains, hotels: schema.hotels, rooms: schema.rooms, reservations: schema.reservations }, { seed: 1 }).refine(
    (f) => ({
      chains: {
        count: 5,
        with: {
          hotels: [
            { weight: 0.7, count: [10, 20] },
            { weight: 0.3, count: [30, 50] },
          ],
        },
      },
      hotels: {
        columns: { name: f.companyName() },
        with: {
          rooms: [
            { weight: 0.6, count: [80, 120] },
            { weight: 0.4, count: [200, 400] },
          ],
        },
      },
      rooms: {
        columns: {
          grade: f.weightedRandom([
            { weight: 0.5, value: f.valuesFromArray({ values: ['standard'] }) },
            { weight: 0.3, value: f.valuesFromArray({ values: ['superior'] }) },
            { weight: 0.15, value: f.valuesFromArray({ values: ['deluxe'] }) },
            { weight: 0.05, value: f.valuesFromArray({ values: ['suite', 'penthouse'] }) },
          ]),
        },
        with: {
          reservations: [
            { weight: 0.8, count: [20, 60] },
            { weight: 0.2, count: [80, 150] },
          ],
        },
      },
      reservations: {
        columns: {
          startDate: f.date({ minDate: '2025-05-01', maxDate: '2025-09-30' }),
        },
      },
    }),
  );
}

async function refreshStatistics(connection: Connection) {
  for (const table of TABLES) await connection.query(`ANALYZE TABLE ${table}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
