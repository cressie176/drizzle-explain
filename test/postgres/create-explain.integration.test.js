const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { eq } = require('drizzle-orm');
const { integer, pgTable, text } = require('drizzle-orm/pg-core');
const { createExplain } = require('../../lib');
const { postgresDriver } = require('../../postgres');
const { connectToTestDatabase } = require('./connect-to-test-database');

const widgets = pgTable('widgets', {
  id: integer('id'),
  name: text('name'),
});

describe('createExplain over the PostgreSQL driver', () => {
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

  test('passes a cheap query and reports the raw plan', async () => {
    const explain = createExplain(postgresDriver(pool), { maxCost: 1000000 });

    const analysis = await explain((db) => db.select().from(widgets).where(eq(widgets.id, 2)));

    assert.equal(analysis.passed, true, analysis.message);
    assert.equal(analysis.message, '');
    assert.ok(Array.isArray(analysis.plan));
  });

  test('fails when the plan cost exceeds a tight maxCost', async () => {
    const explain = createExplain(postgresDriver(pool), { maxCost: 0 });

    const analysis = await explain((db) => db.select().from(widgets));

    assert.equal(analysis.passed, false);
    assert.match(analysis.message, /exceeds limit 0/);
  });

  test('rolls back a write executed through the query callback', async () => {
    const explain = createExplain(postgresDriver(pool));

    await explain((db) => db.insert(widgets).values({ id: 42, name: 'ephemeral' }));

    const { rows } = await pool.query('SELECT id FROM widgets WHERE id = 42');
    assert.deepEqual(rows, []);
  });
});
