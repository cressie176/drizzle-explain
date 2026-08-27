const { deepEqual: deq, equal, ok } = require('node:assert/strict');
const { before, after, describe, test } = require('node:test');
const { int, mysqlTable, varchar } = require('drizzle-orm/mysql-core');
const { eq } = require('drizzle-orm');
const { mariadbDriver } = require('../../mariadb');
const { Operation } = require('../../lib/operation');
const { connect } = require('./connect');

const widgets = mysqlTable('widgets', {
  id: int('id').primaryKey(),
  name: varchar('name', { length: 64 }),
  quantity: int('quantity'),
});

let client;

before(async () => {
  client = await connect();
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
    equal(Number(rows[0].total), 0);
  });

  test('reports estimated rows, actual rows and actual time on access nodes', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    const accessNodes = flatten(statement.root).filter((node) => node.type.includes('widgets'));
    ok(accessNodes.length > 0);
    for (const node of accessNodes) {
      equal(typeof node.estimatedRows, 'number');
      equal(typeof node.actualRows, 'number');
      equal(typeof node.actualTimeMs, 'number');
    }
  });

  test('reports actual time on the root query block', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets));

    equal(typeof statement.root.actualTimeMs, 'number');
  });

  test('reports a numeric cost on the root query block so maxCost can be checked', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    equal(typeof statement.root.cost, 'number');
    ok(statement.root.cost > 0);
  });

  test('classifies a full-table scan as the normalized SEQ_SCAN operation', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    const scanNodes = flatten(statement.root).filter((node) => node.operation === Operation.SEQ_SCAN);
    ok(scanNodes.length > 0);
  });

  test('preserves the unmodified MariaDB plan', async () => {
    const driver = mariadbDriver(client);
    const [statement] = await driver.explain((db) => db.select().from(widgets));

    ok(statement.plan.query_block);
    equal(statement.plan.query_block.select_id, 1);
  });

  test('returns the real rows to the query function', async () => {
    const driver = mariadbDriver(client);
    let observed;

    await driver.explain(async (db) => {
      observed = await db.select().from(widgets).where(eq(widgets.id, 2));
    });

    equal(observed.length, 1);
    equal(observed[0].name, 'b');
    equal(observed[0].quantity, 20);
  });

  test('records the sql and params of each statement', async () => {
    const driver = mariadbDriver(client);

    const [statement] = await driver.explain((db) => db.select().from(widgets).where(eq(widgets.id, 2)));

    ok(statement.sql.includes('`widgets`'));
    deq(statement.params, [2]);
  });

  test('applies a write exactly once so a dependent read sees it', async () => {
    const driver = mariadbDriver(client);
    let observed;

    const statements = await driver.explain(async (db) => {
      await db.insert(widgets).values({ id: 42, name: 'transient', quantity: 7 });
      observed = await db.select().from(widgets).where(eq(widgets.id, 42));
    });

    equal(observed.length, 1);
    equal(observed[0].quantity, 7);
    equal(statements.length, 2);
    deq(statements[1].params, [42]);
  });

  test('reports affected rows to the query function after a write', async () => {
    const driver = mariadbDriver(client);
    let result;

    await driver.explain(async (db) => {
      result = await db.insert(widgets).values({ id: 43, name: 'counted', quantity: 1 });
    });

    equal(result[0].affectedRows, 1);
  });

  test('returns one statement per executed query', async () => {
    const driver = mariadbDriver(client);
    const statements = await driver.explain((db) => db.select().from(widgets));

    equal(statements.length, 1);
  });
});

function flatten(node) {
  return [node, ...node.children.flatMap(flatten)];
}
