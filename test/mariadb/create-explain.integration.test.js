const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { eq } = require('drizzle-orm');
const { int, mysqlTable, varchar } = require('drizzle-orm/mysql-core');
const { createExplain } = require('../../lib');
const { mariadbDriver } = require('../../mariadb');
const { connectMariadb } = require('./connect-mariadb');

const widgets = mysqlTable('widgets', {
  id: int('id').primaryKey(),
  name: varchar('name', { length: 64 }),
  quantity: int('quantity'),
});

describe('createExplain over the MariaDB driver', () => {
  let client;

  before(async () => {
    client = await connectMariadb();
    await client.query('DROP TABLE IF EXISTS widgets');
    await client.query('CREATE TABLE widgets (id INT PRIMARY KEY, name VARCHAR(64), quantity INT)');
    await client.query("INSERT INTO widgets VALUES (1, 'a', 10), (2, 'b', 20), (3, 'c', 30)");
  });

  after(async () => {
    await client.query('DROP TABLE IF EXISTS widgets');
    await client.end();
  });

  test('passes a query whose cost is within a generous maxCost', async () => {
    const explain = createExplain(mariadbDriver(client), { maxCost: 1000000 });

    const analysis = await explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    assert.equal(analysis.passed, true, analysis.message);
    assert.equal(analysis.message, '');
  });

  test('fails when the plan cost exceeds a tight maxCost', async () => {
    const explain = createExplain(mariadbDriver(client), { maxCost: 0 });

    const analysis = await explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    assert.equal(analysis.passed, false);
    assert.match(analysis.message, /exceeds limit 0/);
  });

  test('rolls back a write executed through the query callback', async () => {
    const explain = createExplain(mariadbDriver(client));

    await explain((db) => db.insert(widgets).values({ id: 99, name: 'z', quantity: 999 }));

    const [rows] = await client.query('SELECT COUNT(*) AS total FROM widgets WHERE id = 99');
    assert.equal(Number(rows[0].total), 0);
  });
});
