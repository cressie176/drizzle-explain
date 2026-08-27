const { equal, deepEqual: deq, ok, rejects } = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { eq } = require('drizzle-orm');
const { integer, pgTable, text } = require('drizzle-orm/pg-core');
const { postgresDriver } = require('../../postgres');
const { Operation } = require('../../lib/operation');
const { connect } = require('./connect');

const widgets = pgTable('widgets', {
  id: integer('id'),
  name: text('name'),
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
