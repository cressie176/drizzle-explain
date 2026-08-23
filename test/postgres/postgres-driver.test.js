const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { eq } = require('drizzle-orm');
const { integer, pgTable, text } = require('drizzle-orm/pg-core');
const { postgresDriver } = require('../../postgres');
const { connectToTestDatabase } = require('./connect-to-test-database');

const widgets = pgTable('widgets', {
  id: integer('id'),
  name: text('name'),
});

describe('postgresDriver', () => {
  let pool;

  before(async () => {
    pool = connectToTestDatabase();
    await pool.query('DROP TABLE IF EXISTS widgets');
    await pool.query('CREATE TABLE IF NOT EXISTS widgets (id integer, name text)');
    await pool.query("INSERT INTO widgets (id, name) VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')");
  });

  after(async () => {
    await pool.query('DROP TABLE IF EXISTS widgets');
    await pool.end();
  });

  test('returns one ExplainedStatement per generated statement', async () => {
    const driver = postgresDriver(pool);

    const statements = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.id, 2)));

    assert.equal(statements.length, 1);
  });

  test('normalized root carries cost, estimatedRows, actualRows and actualTimeMs', async () => {
    const driver = postgresDriver(pool);

    const [statement] = await driver.explain((db) => db.select().from(widgets));
    const { root } = statement;

    assert.equal(root.type, 'Seq Scan');
    assert.equal(typeof root.cost, 'number');
    assert.equal(typeof root.estimatedRows, 'number');
    assert.equal(typeof root.actualRows, 'number');
    assert.equal(typeof root.actualTimeMs, 'number');
    assert.deepEqual(root.children, []);
  });

  test('plan holds the unmodified PostgreSQL EXPLAIN output', async () => {
    const driver = postgresDriver(pool);

    const [statement] = await driver.explain((db) => db.select().from(widgets));

    assert.ok(Array.isArray(statement.plan));
    assert.equal(typeof statement.plan[0].Plan['Node Type'], 'string');
    assert.equal(typeof statement.plan[0]['Execution Time'], 'number');
  });

  test('a seq scan on an unindexed column reports a measurable cost', async () => {
    const driver = postgresDriver(pool);

    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.name, 'beta')));

    assert.equal(statement.root.type, 'Seq Scan');
    assert.ok(statement.root.cost > 0);
  });

  test('a write run through the driver leaves the database unchanged', async () => {
    const driver = postgresDriver(pool);

    await driver.explain((db) => db.insert(widgets).values({ id: 99, name: 'ephemeral' }));

    const { rows } = await pool.query('SELECT id FROM widgets WHERE id = 99');
    assert.deepEqual(rows, []);
  });

  test('rolls back and releases the connection when run throws', async () => {
    const driver = postgresDriver(pool);
    const boom = new Error('boom');

    await assert.rejects(
      driver.explain(async (db) => {
        await db.insert(widgets).values({ id: 100, name: 'doomed' });
        throw boom;
      }),
      boom,
    );

    const { rows } = await pool.query('SELECT id FROM widgets WHERE id = 100');
    assert.deepEqual(rows, []);
    assert.equal(pool.idleCount, pool.totalCount);
  });
});
