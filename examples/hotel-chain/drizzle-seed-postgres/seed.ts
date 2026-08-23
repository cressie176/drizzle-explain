import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seed } from 'drizzle-seed';
import { connect } from './connect.ts';
import * as schema from './schema.ts';

const DDL = sql`
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

async function seedShapedData(db: ReturnType<typeof drizzle>) {
  await seed(db, schema, { seed: 1 }).refine((f) => ({
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
  }));
}

async function reportCounts(db: ReturnType<typeof drizzle>) {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM chains) AS chains,
      (SELECT count(*) FROM hotels) AS hotels,
      (SELECT count(*) FROM rooms) AS rooms,
      (SELECT count(*) FROM reservations) AS reservations
  `);
  return rows[0];
}

async function run() {
  const pool = connect();
  const db = drizzle(pool);

  console.log('[1/3] Recreating tables…');
  await db.execute(DDL);

  console.log('[2/3] Seeding data with drizzle-seed — this takes a minute or two, please wait…');
  await seedShapedData(db);

  console.log('[3/3] Refreshing statistics (ANALYZE)…');
  await db.execute(sql`ANALYZE;`);

  console.log('Seed complete:', await reportCounts(db));
  await pool.end();
}

run();
