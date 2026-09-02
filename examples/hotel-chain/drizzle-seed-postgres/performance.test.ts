import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { createExplain, Operation } from 'drizzle-explain';
import { postgresDriver } from 'drizzle-explain/postgres';
import type { Driver, Limits } from 'drizzle-explain';
import { connect } from './connect.ts';
import type { Db } from './queries.ts';
import * as queries from './queries.ts';

const pool = connect();
const driver = postgresDriver(pool) as Driver<Db>;
const explain = createExplain(driver, { maxCost: 500, rowEstimateTolerance: 20 });

after(() => pool.end());

type Case = { run: (db: Db) => unknown; limits?: Limits } | { skip: string } | { breaches: (db: Db) => unknown; limits?: Limits };

// Each query is either tested with representative arguments and (optional)
// limit overrides, or explicitly skipped with a reason. A query that appears
// in the module but not here fails the coverage test below — it can't be
// silently untested.
const THRESHOLDS: Record<keyof typeof queries, Case[]> = {
  findReservationsByRoom: [{ run: (db) => queries.findReservationsByRoom(db, 42) }],
  occupancyByHotel: [
    // Peak vs shoulder season: selectivity differs, so test both. A hotel holds
    // thousands of reservations, so a summer date range legitimately scans a
    // large slice — cost accepted with eyes open.
    { run: (db) => queries.occupancyByHotel(db, 3, '2025-07-01', '2025-07-31'), limits: { maxCost: 15000 } },
    { run: (db) => queries.occupancyByHotel(db, 3, '2025-11-01', '2025-11-30') },
  ],
  roomsByGrade: [
    { run: (db) => queries.roomsByGrade(db, 'penthouse') },
    // 'standard' is the common grade, so the index gives way to a scan of most
    // of the table — the cost is inherent to the selectivity, not a missing index.
    { run: (db) => queries.roomsByGrade(db, 'standard'), limits: { maxCost: 5000 } },
  ],
  // Joins the five-row grades lookup. PostgreSQL reads all five rather than
  // using the index, which is the right choice at that size, so SEQ_SCAN is
  // banned and lifted for that table alone — and only while it stays small.
  // Rooms is reached through rooms_grade_idx, so it needs no exemption.
  roomsByGradeWithLabel: [
    {
      run: (db) => queries.roomsByGradeWithLabel(db, 'penthouse'),
      limits: {
        disallowOperations: [Operation.SEQ_SCAN],
        allowOperations: [{ operation: Operation.SEQ_SCAN, relation: 'grades', maxScanned: 10 }],
      },
    },
    // 'standard' is half the rooms, so the index gives way to a full scan. The
    // grades exemption does not cover it: naming the table is what stops the
    // allowance leaking onto the large one.
    {
      breaches: (db) => queries.roomsByGradeWithLabel(db, 'standard'),
      limits: {
        disallowOperations: [Operation.SEQ_SCAN],
        allowOperations: [{ operation: Operation.SEQ_SCAN, relation: 'grades', maxScanned: 10 }],
      },
    },
  ],

  // Counting every room legitimately reads every room, so both scans are
  // accepted — but for different reasons, and each says which.
  roomCountsByGrade: [
    {
      run: (db) => queries.roomCountsByGrade(db),
      limits: {
        maxCost: 2000,
        disallowOperations: [Operation.SEQ_SCAN],
        allowOperations: [
          { operation: Operation.SEQ_SCAN, relation: 'grades', maxScanned: 10 },
          { operation: Operation.SEQ_SCAN, relation: 'rooms' },
        ],
      },
    },
  ],

  // Four-table join across the whole chain returns ~130k rows; accepted cost.
  reservationsForChain: [{ run: (db) => queries.reservationsForChain(db, 2), limits: { maxCost: 10000 } }],
  // Unindexed substring match forces a full scan — kept here to demonstrate a
  // breach and the annotated failure output, rather than to pass.
  findReservationsByGuest: [{ breaches: (db) => queries.findReservationsByGuest(db, '%aa%') }],
};

describe('query performance', () => {
  test('every query is tested or skipped', () => {
    const untested = Object.keys(queries).filter((name) => !(name in THRESHOLDS));
    assert.deepEqual(untested, [], `queries missing from THRESHOLDS: ${untested.join(', ')}`);
  });

  for (const [name, cases] of Object.entries(THRESHOLDS)) {
    test(name, async (t) => {
      for (const c of cases) {
        if ('skip' in c) {
          t.skip(c.skip);
          continue;
        }
        if ('breaches' in c) {
          const analysis = await explain(c.breaches, { statements: 1, limits: c.limits });
          assert.equal(analysis.passed, false, 'expected this query to breach its limit');
          assert.notEqual(analysis.message, '');
          continue;
        }
        const analysis = await explain(c.run, { statements: 1, limits: c.limits });
        assert.ok(analysis.passed, analysis.message);
      }
    });
  }
});
