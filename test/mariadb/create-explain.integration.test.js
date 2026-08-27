const { equal, match, rejects } = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { eq } = require('drizzle-orm');
const { int, mysqlTable, varchar } = require('drizzle-orm/mysql-core');
const { createExplain, Operation } = require('../../lib');
const { mariadbDriver } = require('../../mariadb');
const { connect } = require('./connect');

const widgets = mysqlTable('widgets', {
  id: int('id').primaryKey(),
  name: varchar('name', { length: 64 }),
  quantity: int('quantity'),
});

async function findQuantityByName(db, name) {
  const [found] = await db.select({ quantity: widgets.quantity }).from(widgets).where(eq(widgets.name, name));
  return found.quantity;
}

async function findWidgetsStockedLike(db, name) {
  const quantity = await findQuantityByName(db, name);
  return db.select().from(widgets).where(eq(widgets.quantity, quantity));
}

describe('createExplain over the MariaDB driver', () => {
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

  test('passes a query whose cost is within a generous maxCost', async () => {
    const explain = createExplain(mariadbDriver(client), { maxCost: 1000000 });

    const analysis = await explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    equal(analysis.passed, true, analysis.message);
    equal(analysis.message, '');
  });

  test('fails when the plan cost exceeds a tight maxCost', async () => {
    const explain = createExplain(mariadbDriver(client), { maxCost: 0 });

    const analysis = await explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    equal(analysis.passed, false);
    match(analysis.message, /exceeds limit 0/);
  });

  test('fails when the plan runs a disallowed operation', async () => {
    const explain = createExplain(mariadbDriver(client), { disallowOperations: [Operation.SEQ_SCAN] });

    const analysis = await explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)));

    equal(analysis.passed, false);
    match(analysis.message, /disallowed operation:/);
  });

  test('a per-call allowOperations override permits an otherwise-disallowed operation', async () => {
    const explain = createExplain(mariadbDriver(client), { disallowOperations: [Operation.SEQ_SCAN] });

    const analysis = await explain((db) => db.select().from(widgets).where(eq(widgets.quantity, 20)), {
      allowOperations: [Operation.SEQ_SCAN],
    });

    equal(analysis.passed, true, analysis.message);
  });

  test('analyses every statement a public query function issues', async () => {
    const explain = createExplain(mariadbDriver(client), { maxCost: 1000000 });

    const analysis = await explain((db) => findWidgetsStockedLike(db, 'b'), [{}, {}]);

    equal(analysis.passed, true, analysis.message);
    equal(analysis.statements.length, 2);
  });

  test('a dependent statement is explained with the parameters its predecessor produced', async () => {
    const explain = createExplain(mariadbDriver(client));

    const analysis = await explain((db) => findWidgetsStockedLike(db, 'c'), [{ maxCost: 1000000 }, { maxCost: 0 }]);

    match(analysis.message, /params: \[30\]/);
  });

  test('throws when the callback issues more statements than limits supplied', async () => {
    const explain = createExplain(mariadbDriver(client));

    await rejects(
      explain((db) => findWidgetsStockedLike(db, 'b'), [{}]),
      /expected 1 statements \(limits array length\) but 2 were executed/,
    );
  });

  test('analyses a Promise.all of a write and an independent read with distinct limits', async () => {
    const explain = createExplain(mariadbDriver(client), { maxCost: 1000000 });

    const analysis = await explain(
      (db) =>
        Promise.all([
          db.insert(widgets).values({ id: 60, name: 'concurrent', quantity: 6 }),
          db.select().from(widgets).where(eq(widgets.quantity, 20)),
        ]),
      [{}, { maxCost: 0 }],
    );

    equal(analysis.passed, false);
    equal(analysis.statements[0].passed, true);
    equal(analysis.statements[1].passed, false);
    match(analysis.message, /statement 2 of 2/);

    const [rows] = await client.query('SELECT COUNT(*) AS total FROM widgets WHERE id = 60');
    equal(Number(rows[0].total), 0);
  });

  test('rolls back a write executed through the query callback', async () => {
    const explain = createExplain(mariadbDriver(client));

    await explain((db) => db.insert(widgets).values({ id: 99, name: 'z', quantity: 999 }));

    const [rows] = await client.query('SELECT COUNT(*) AS total FROM widgets WHERE id = 99');
    equal(Number(rows[0].total), 0);
  });
});
