import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createExplain } from 'drizzle-explain';
import { mariadbDriver } from 'drizzle-explain/mariadb';
import type { Connection } from 'mysql2/promise';
import { connect } from './connect.ts';
import type { Db } from './queries.ts';
import * as queries from './queries.ts';

type RunCase = {
  run: (db: Db) => unknown;
  limits?: { maxCost?: number; rowEstimateTolerance?: number };
  expectBreach?: boolean;
};

type SkipCase = { skip: string };

type Case = RunCase | SkipCase;

let connection: Connection;
let explain: ReturnType<typeof createExplain>;

before(async () => {
  connection = await connect();
  explain = createExplain(mariadbDriver(connection), { rowEstimateTolerance: 10 });
});

after(async () => {
  await connection.end();
});

// Each query is either tested with representative arguments and (optional)
// limit overrides, or explicitly skipped with a reason. A query that appears
// in the module but not here fails the coverage test below, so no query can
// be silently untested.
const THRESHOLDS: Record<keyof typeof queries, Case[]> = {
  // Indexed lookup on reservations.room_id. MariaDB reports a cost here, so
  // maxCost is enforced alongside rowEstimateTolerance.
  findReservationsByRoom: [{ run: (db) => queries.findReservationsByRoom(db, 42), limits: { maxCost: 5 } }],

  // Peak vs shoulder season: selectivity differs across the join, so test both.
  occupancyByHotel: [
    { run: (db) => queries.occupancyByHotel(db, 3, '2025-07-01', '2025-07-31'), limits: { maxCost: 50 } },
    { run: (db) => queries.occupancyByHotel(db, 3, '2025-11-01', '2025-11-30'), limits: { rowEstimateTolerance: 50 } },
  ],

  // Grade skew makes 'standard' common and 'penthouse' rare; both use the
  // grade index but with very different selectivity.
  roomsByGrade: [
    { run: (db) => queries.roomsByGrade(db, 'standard'), limits: { maxCost: 100 } },
    { run: (db) => queries.roomsByGrade(db, 'penthouse'), limits: { maxCost: 100 } },
  ],

  // chain -> hotel -> room join, driven by indexed foreign keys.
  roomsForChain: [{ run: (db) => queries.roomsForChain(db, 2), limits: { maxCost: 100 } }],

  // A `const` primary-key lookup. MariaDB omits cost for const access, so
  // maxCost is SKIPPED (not failed) even though we set a limit of 0 — this
  // case passes, proving the driver silently skips an unavailable signal.
  chainById: [{ run: (db) => queries.chainById(db, 1), limits: { maxCost: 0 } }],

  // Intentionally pathological: guest_name has no index and the leading
  // wildcard forbids one anyway, so this full-scans reservations. With a tiny
  // maxCost it BREACHES, demonstrating the annotated failure output.
  reservationsByGuestName: [{ run: (db) => queries.reservationsByGuestName(db, '%a%'), limits: { maxCost: 1 }, expectBreach: true }],
};

describe('query performance', () => {
  test('every query is tested or skipped', () => {
    const untested = Object.keys(queries).filter((name) => !(name in THRESHOLDS));
    assert.deepEqual(untested, [], `queries missing from THRESHOLDS: ${untested.join(', ')}`);
  });

  for (const [name, cases] of Object.entries(THRESHOLDS)) {
    test(name, async (t) => {
      for (const testCase of cases) {
        if ('skip' in testCase) {
          t.skip(testCase.skip);
          continue;
        }
        await runCase(testCase);
      }
    });
  }
});

async function runCase(testCase: RunCase) {
  const analysis = await explain((db) => testCase.run(db as Db), testCase.limits);
  if (testCase.expectBreach) return assertBreached(analysis);
  return assertWithinLimits(analysis);
}

function assertWithinLimits(analysis: { passed: boolean; message: string }) {
  assert.equal(analysis.passed, true, analysis.message);
}

function assertBreached(analysis: { passed: boolean; message: string }) {
  assert.equal(analysis.passed, false, 'expected the unindexed full scan to breach its limit');
  assert.notEqual(analysis.message, '', 'a breach must produce an annotated plan message');
}
