const assert = require('node:assert/strict');
const { before, after, describe, test } = require('node:test');
const { int, mysqlTable, varchar } = require('drizzle-orm/mysql-core');
const { eq } = require('drizzle-orm');
const { mariadbDriver } = require('../../mariadb');
const { connectMariadb } = require('./connect-mariadb');

const widgets = mysqlTable('widgets', {
  id: int('id').primaryKey(),
  name: varchar('name', { length: 64 }),
  quantity: int('quantity'),
});

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

describe('mariadbDriver', () => {
  test('leaves the database unchanged after a write', async () => {
    const driver = mariadbDriver(client);
    await driver.explain((db) => db.insert(widgets).values({ id: 99, name: 'z', quantity: 999 }));

    const [rows] = await client.query('SELECT COUNT(*) AS total FROM widgets WHERE id = 99');
    assert.equal(Number(rows[0].total), 0);
  });

  test('reports estimated rows, actual rows and actual time on access nodes', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    const accessNodes = flatten(statement.root).filter((node) => node.type.includes('widgets'));
    assert.ok(accessNodes.length > 0);
    for (const node of accessNodes) {
      assert.equal(typeof node.estimatedRows, 'number');
      assert.equal(typeof node.actualRows, 'number');
      assert.equal(typeof node.actualTimeMs, 'number');
    }
  });

  test('reports actual time on the root query block', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets));

    assert.equal(typeof statement.root.actualTimeMs, 'number');
  });

  test('reports a numeric cost on the root query block so maxCost can be checked', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    assert.equal(typeof statement.root.cost, 'number');
    assert.ok(statement.root.cost > 0);
  });

  test('preserves the unmodified MariaDB plan', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets));

    assert.ok(statement.plan.query_block);
    assert.equal(statement.plan.query_block.select_id, 1);
  });

  test('returns one statement per executed query', async () => {
    const driver = mariadbDriver(client);
    const statements = await driver.explain((db) => db.select().from(widgets));

    assert.equal(statements.length, 1);
  });
});

function flatten(node) {
  return [node, ...node.children.flatMap(flatten)];
}
