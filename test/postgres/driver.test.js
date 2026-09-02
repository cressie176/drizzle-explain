const { equal, deepEqual: deq, ok, rejects } = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { analysePlan } = require('../../lib/analyse-plan');
const { alias } = require('drizzle-orm/pg-core');
const { count, eq, sql, TransactionRollbackError } = require('drizzle-orm');
const { integer, pgTable, text } = require('drizzle-orm/pg-core');
const { postgresDriver } = require('../../postgres');
const { Operation } = require('../../lib/operation');
const { connect } = require('./connect');

function doNothing() {}

const widgets = pgTable('widgets', {
  id: integer('id'),
  name: text('name'),
});

const missing = pgTable('missing_table', {
  id: integer('id'),
});

describe('postgresDriver', () => {
  let pool;

  before(async () => {
    pool = connect();
    await pool.query('DROP TABLE IF EXISTS widgets');
    await pool.query('CREATE TABLE IF NOT EXISTS widgets (id integer, name text)');
    await pool.query("INSERT INTO widgets (id, name) VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')");
  });

  after(async () => {
    await pool.query('DROP TABLE IF EXISTS widgets');
    await pool.end();
  });

  test('returns one statement per executed query', async () => {
    const driver = postgresDriver(pool);

    const statements = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.id, 2)));

    equal(statements.length, 1);
  });

  test('normalized root carries cost, estimatedRows, actualRows and actualTimeMs', async () => {
    const driver = postgresDriver(pool);

    const [statement] = await driver.explain((db) => db.select().from(widgets));
    const { root } = statement;

    equal(root.type, 'Seq Scan');
    equal(typeof root.cost, 'number');
    equal(typeof root.estimatedRows, 'number');
    equal(typeof root.actualRows, 'number');
    equal(typeof root.actualTimeMs, 'number');
    deq(root.children, []);
  });

  test('preserves the unmodified PostgreSQL plan', async () => {
    const driver = postgresDriver(pool);

    const [statement] = await driver.explain((db) => db.select().from(widgets));

    ok(Array.isArray(statement.plan));
    equal(typeof statement.plan[0].Plan['Node Type'], 'string');
    equal(typeof statement.plan[0]['Execution Time'], 'number');
  });

  test('a seq scan on an unindexed column reports a measurable cost', async () => {
    const driver = postgresDriver(pool);

    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.name, 'beta')));

    equal(statement.root.type, 'Seq Scan');
    ok(statement.root.cost > 0);
  });

  test('classifies a full-table scan as the normalized SEQ_SCAN operation', async () => {
    const driver = postgresDriver(pool);

    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.name, 'beta')));

    equal(statement.root.operation, Operation.SEQ_SCAN);
  });

  test('returns the real rows to the query function', async () => {
    const driver = postgresDriver(pool);
    let observed;

    await driver.explain(async (db) => {
      observed = await db.select().from(widgets).where(eq(widgets.id, 2));
    });

    deq(observed, [{ id: 2, name: 'beta' }]);
  });

  test('records the sql and params of each statement', async () => {
    const driver = postgresDriver(pool);

    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.id, 2)));

    ok(statement.sql.includes('from "widgets"'));
    deq(statement.params, [2]);
  });

  test('applies a write exactly once so a dependent read sees it', async () => {
    const driver = postgresDriver(pool);
    let inserted;
    let observed;

    const statements = await driver.explain(async (db) => {
      inserted = await db.insert(widgets).values({ id: 42, name: 'transient' }).returning();
      observed = await db.select().from(widgets).where(eq(widgets.id, inserted[0].id));
    });

    deq(inserted, [{ id: 42, name: 'transient' }]);
    deq(observed, [{ id: 42, name: 'transient' }]);
    equal(statements.length, 2);
    deq(statements[1].params, [42]);
  });

  test('returns the result of a write issued without returning', async () => {
    const driver = postgresDriver(pool);
    let observed;

    await driver.explain(async (db) => {
      await db.insert(widgets).values({ id: 43, name: 'unreturned' });
      observed = await db.select().from(widgets).where(eq(widgets.id, 43));
    });

    deq(observed, [{ id: 43, name: 'unreturned' }]);
  });

  describe('concurrent statements', () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const warnings = [];
    const collectWarning = (warning) => warnings.push(warning);

    before(() => process.on('warning', collectWarning));
    after(() => process.removeListener('warning', collectWarning));

    test('serialises a Promise.all so each statement sees the effects exactly once', async () => {
      const driver = postgresDriver(pool);
      let observed;

      const statements = await driver.explain(async (db) => {
        await Promise.all([
          db.insert(widgets).values({ id: 50, name: 'concurrent' }),
          db.select().from(widgets).where(eq(widgets.id, 50)),
        ]);
        observed = await db.select().from(widgets).where(eq(widgets.id, 50));
      });

      equal(statements.length, 3);
      deq(observed, [{ id: 50, name: 'concurrent' }]);
    });

    test('pairs Promise.all statements in array order', async () => {
      const driver = postgresDriver(pool);

      const statements = await driver.explain((db) =>
        Promise.all([
          db.select().from(widgets).where(eq(widgets.id, 1)),
          db.select().from(widgets).where(eq(widgets.id, 2)),
        ]),
      );

      deq(
        statements.map((statement) => statement.params),
        [[1], [2]],
      );
    });

    test('applies staggered overlapping writes exactly once each', async () => {
      const driver = postgresDriver(pool);
      let observed;

      await driver.explain(async (db) => {
        const first = db.insert(widgets).values({ id: 51, name: 'early' }).execute();
        await sleep(1);
        const second = db.insert(widgets).values({ id: 52, name: 'late' }).execute();
        await Promise.all([first, second]);
        observed = await db.select().from(widgets).where(eq(widgets.name, 'early'));
      });

      deq(observed, [{ id: 51, name: 'early' }]);
    });

    test('a raced statement still completes and is counted', async () => {
      const driver = postgresDriver(pool);

      const statements = await driver.explain((db) =>
        Promise.race([
          db.select().from(widgets).where(eq(widgets.id, 1)),
          db.select().from(widgets).where(eq(widgets.id, 2)),
        ]),
      );

      equal(statements.length, 2);
    });

    test('a statement that fails after the callback resolved rejects the run', async () => {
      const driver = postgresDriver(pool);

      await rejects(
        driver.explain((db) =>
          Promise.race([
            db.select().from(widgets).where(eq(widgets.id, 1)),
            db.select().from(missing).where(eq(missing.id, 1)),
          ]),
        ),
        /missing_table/,
      );
    });

    test('never overlaps queries on the connection', () => {
      const overlaps = warnings.filter((warning) => /already executing/.test(warning.message));
      deq(overlaps, []);
    });
  });

  describe('transactions', () => {
    test('explains every statement issued inside a transaction callback', async () => {
      const driver = postgresDriver(pool);

      const statements = await driver.explain((db) =>
        db.transaction(async (tx) => {
          await tx.insert(widgets).values({ id: 200, name: 'first' });
          await tx.insert(widgets).values({ id: 201, name: 'second' });
        }),
      );

      equal(statements.length, 2);
    });

    test('returns the transaction callback result and applies its writes for later statements', async () => {
      const driver = postgresDriver(pool);
      let returned;
      let observed;

      await driver.explain(async (db) => {
        returned = await db.transaction((tx) => tx.insert(widgets).values({ id: 202, name: 'kept' }).returning());
        observed = await db.select().from(widgets).where(eq(widgets.id, 202));
      });

      deq(returned, [{ id: 202, name: 'kept' }]);
      deq(observed, [{ id: 202, name: 'kept' }]);
    });

    test('rolling back a transaction undoes its writes and rejects with TransactionRollbackError', async () => {
      const driver = postgresDriver(pool);
      let observed;

      await driver.explain(async (db) => {
        await rejects(
          db.transaction(async (tx) => {
            await tx.insert(widgets).values({ id: 203, name: 'abandoned' });
            await tx.rollback();
          }),
          TransactionRollbackError,
        );
        observed = await db.select().from(widgets).where(eq(widgets.id, 203));
      });

      deq(observed, []);
    });

    test('an error thrown inside a transaction undoes its writes and propagates', async () => {
      const driver = postgresDriver(pool);
      const boom = new Error('boom');
      let observed;

      await driver.explain(async (db) => {
        await rejects(
          db.transaction(async (tx) => {
            await tx.insert(widgets).values({ id: 204, name: 'doomed' });
            throw boom;
          }),
          boom,
        );
        observed = await db.select().from(widgets).where(eq(widgets.id, 204));
      });

      deq(observed, []);
    });

    test('rolling back a nested transaction keeps the writes of the enclosing one', async () => {
      const driver = postgresDriver(pool);
      let observed;

      await driver.explain(async (db) => {
        await db.transaction(async (tx) => {
          await tx.insert(widgets).values({ id: 205, name: 'outer' });
          await rejects(
            tx.transaction(async (inner) => {
              await inner.insert(widgets).values({ id: 206, name: 'inner' });
              await inner.rollback();
            }),
            TransactionRollbackError,
          );
        });
        observed = await db.select().from(widgets).where(eq(widgets.name, 'outer'));
      });

      deq(observed, [{ id: 205, name: 'outer' }]);
    });

    test('leaves the database unchanged after a committed transaction', async () => {
      const driver = postgresDriver(pool);

      await driver.explain((db) => db.transaction((tx) => tx.insert(widgets).values({ id: 207, name: 'ephemeral' })));

      const { rows } = await pool.query('SELECT id FROM widgets WHERE id = 207');
      deq(rows, []);
    });
  });

  describe('scanned relations', () => {
    test('names the table an access node scans', async () => {
      const driver = postgresDriver(pool);

      const [statement] = await driver.explain((db) => db.select().from(widgets));

      equal(statement.root.relation, 'widgets');
      equal(statement.root.alias, undefined);
    });

    test('reports the alias alongside the table when the query aliases it', async () => {
      const driver = postgresDriver(pool);
      const aliased = alias(widgets, 'w');

      const [statement] = await driver.explain((db) => db.select().from(aliased));

      equal(statement.root.relation, 'widgets');
      equal(statement.root.alias, 'w');
    });

    test('reports rows scanned before filtering, not rows returned', async () => {
      const driver = postgresDriver(pool);
      let returned;

      const [statement] = await driver.explain(async (db) => {
        returned = await db.select().from(widgets).where(eq(widgets.id, 2));
      });

      equal(returned.length, 1);
      equal(statement.root.actualRows, 1);
      equal(statement.root.scanned, 3);
    });

    test('scanned equals actual rows where nothing is filtered out', async () => {
      const driver = postgresDriver(pool);

      const [statement] = await driver.explain((db) => db.select().from(widgets));

      equal(statement.root.scanned, statement.root.actualRows);
    });

    test('leaves a node that scans no relation without one', async () => {
      const driver = postgresDriver(pool);

      const [statement] = await driver.explain((db) => db.select({ total: count() }).from(widgets));

      equal(statement.root.relation, undefined);
      equal(statement.root.scanned, undefined);
    });
  });

  describe('failures the callback handles', () => {
    test('a statement error the callback catches leaves the run intact', async () => {
      const driver = postgresDriver(pool);
      let caught;
      let observed;

      const statements = await driver.explain(async (db) => {
        await db
          .select()
          .from(missing)
          .catch((error) => {
            caught = error;
          });
        observed = await db.select().from(widgets).where(eq(widgets.id, 1));
      });

      ok(caught);
      equal(observed.length, 1);
      equal(statements.length, 1);
    });

    test('a statement error the callback lets escape still rejects the run', async () => {
      const driver = postgresDriver(pool);

      await rejects(
        driver.explain((db) => db.select().from(missing)),
        /missing_table/,
      );
    });

    test('a transaction the callback catches leaves the run intact', async () => {
      const driver = postgresDriver(pool);
      let observed;

      const statements = await driver.explain(async (db) => {
        await db.transaction((tx) => tx.select().from(missing)).catch(doNothing);
        observed = await db.select().from(widgets).where(eq(widgets.id, 1));
      });

      equal(observed.length, 1);
      equal(statements.length, 1);
    });
  });

  describe('repeated executions', () => {
    before(async () => {
      await pool.query('DROP TABLE IF EXISTS outers');
      await pool.query('CREATE TABLE outers (id integer)');
      await pool.query('INSERT INTO outers SELECT g FROM generate_series(1, 200) g');
      await pool.query('DROP TABLE IF EXISTS inners');
      await pool.query('CREATE TABLE inners (id integer, tag text)');
      await pool.query("INSERT INTO inners SELECT g, 't' || g FROM generate_series(1, 2000) g");
      await pool.query('ANALYZE outers');
      await pool.query('ANALYZE inners');
    });

    after(async () => {
      await pool.query('DROP TABLE IF EXISTS inners');
      await pool.query('DROP TABLE IF EXISTS outers');
    });

    const lateralScan = (db) =>
      db.execute(
        sql`SELECT o.id, s.n FROM outers o, LATERAL (SELECT count(*) AS n FROM inners i WHERE i.tag = 't' || o.id AND i.id > 0) s`,
      );

    test('counts the rows a repeatedly-executed scan read across every execution', async () => {
      const driver = postgresDriver(pool);

      const [statement] = await driver.explain(lateralScan);

      const [inner] = flatten(statement.root).filter((node) => node.relation === 'inners');
      equal(inner.loops, 200);
      equal(inner.scanned, 400000);
      equal(inner.actualRows, 1);
    });

    test('a scan repeated past the threshold is not exempted by maxScanned', async () => {
      const driver = postgresDriver(pool);
      const limits = {
        disallowOperations: [Operation.SEQ_SCAN],
        allowOperations: [{ operation: Operation.SEQ_SCAN, maxScanned: 500 }],
      };

      const [statement] = await driver.explain(lateralScan);
      const analysis = analysePlan(statement.root, limits);

      equal(analysis.passed, false);
      equal(analysis.breaches.length, 1);
      equal(analysis.breaches[0].node.relation, 'inners');
    });
  });

  test('leaves the database unchanged after a write', async () => {
    const driver = postgresDriver(pool);

    await driver.explain((db) => db.insert(widgets).values({ id: 99, name: 'ephemeral' }));

    const { rows } = await pool.query('SELECT id FROM widgets WHERE id = 99');
    deq(rows, []);
  });

  test('rolls back and releases the connection when run throws', async () => {
    const driver = postgresDriver(pool);
    const boom = new Error('boom');

    await rejects(
      driver.explain(async (db) => {
        await db.insert(widgets).values({ id: 100, name: 'doomed' });
        throw boom;
      }),
      boom,
    );

    const { rows } = await pool.query('SELECT id FROM widgets WHERE id = 100');
    deq(rows, []);
    equal(pool.idleCount, pool.totalCount);
  });
});

function flatten(node) {
  return [node, ...node.children.flatMap(flatten)];
}
