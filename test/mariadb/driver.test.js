const { deepEqual: deq, equal, ok, rejects } = require('node:assert/strict');
const { before, after, describe, test } = require('node:test');
const { int, mysqlTable, varchar } = require('drizzle-orm/mysql-core');
const { eq, TransactionRollbackError } = require('drizzle-orm');
const { mariadbDriver } = require('../../mariadb');
const { Operation } = require('../../lib/operation');
const { connect } = require('./connect');

const widgets = mysqlTable('widgets', {
  id: int('id').primaryKey(),
  name: varchar('name', { length: 64 }),
  quantity: int('quantity'),
});

const missing = mysqlTable('missing_table', {
  id: int('id'),
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

  describe('concurrent statements', () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    test('serialises a Promise.all so each statement sees the effects exactly once', async () => {
      const driver = mariadbDriver(client);
      let observed;

      const statements = await driver.explain(async (db) => {
        await Promise.all([
          db.insert(widgets).values({ id: 50, name: 'concurrent', quantity: 5 }),
          db.select().from(widgets).where(eq(widgets.id, 50)),
        ]);
        observed = await db.select().from(widgets).where(eq(widgets.id, 50));
      });

      equal(statements.length, 3);
      equal(observed.length, 1);
      equal(observed[0].name, 'concurrent');
    });

    test('pairs Promise.all statements in array order', async () => {
      const driver = mariadbDriver(client);

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
      const driver = mariadbDriver(client);
      let observed;

      await driver.explain(async (db) => {
        const first = db.insert(widgets).values({ id: 51, name: 'early', quantity: 1 }).execute();
        await sleep(1);
        const second = db.insert(widgets).values({ id: 52, name: 'late', quantity: 2 }).execute();
        await Promise.all([first, second]);
        observed = await db.select().from(widgets).where(eq(widgets.name, 'early'));
      });

      equal(observed.length, 1);
      equal(observed[0].id, 51);
    });

    test('a raced statement still completes and is counted', async () => {
      const driver = mariadbDriver(client);

      const statements = await driver.explain((db) =>
        Promise.race([
          db.select().from(widgets).where(eq(widgets.id, 1)),
          db.select().from(widgets).where(eq(widgets.id, 2)),
        ]),
      );

      equal(statements.length, 2);
    });

    test('a statement that fails after the callback resolved rejects the run', async () => {
      const driver = mariadbDriver(client);

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
  });

  describe('transactions', () => {
    test('explains every statement issued inside a transaction callback', async () => {
      const driver = mariadbDriver(client);

      const statements = await driver.explain((db) =>
        db.transaction(async (tx) => {
          await tx.insert(widgets).values({ id: 200, name: 'first', quantity: 1 });
          await tx.insert(widgets).values({ id: 201, name: 'second', quantity: 2 });
        }),
      );

      equal(statements.length, 2);
    });

    test('returns the transaction callback result and applies its writes for later statements', async () => {
      const driver = mariadbDriver(client);
      let returned;
      let observed;

      await driver.explain(async (db) => {
        returned = await db.transaction(async (tx) => {
          await tx.insert(widgets).values({ id: 202, name: 'kept', quantity: 3 });
          return 'committed';
        });
        observed = await db.select({ id: widgets.id, name: widgets.name }).from(widgets).where(eq(widgets.id, 202));
      });

      equal(returned, 'committed');
      deq(observed, [{ id: 202, name: 'kept' }]);
    });

    test('rolling back a transaction undoes its writes and rejects with TransactionRollbackError', async () => {
      const driver = mariadbDriver(client);
      let observed;

      await driver.explain(async (db) => {
        await rejects(
          db.transaction(async (tx) => {
            await tx.insert(widgets).values({ id: 203, name: 'abandoned', quantity: 4 });
            await tx.rollback();
          }),
          TransactionRollbackError,
        );
        observed = await db.select({ id: widgets.id }).from(widgets).where(eq(widgets.id, 203));
      });

      deq(observed, []);
    });

    test('an error thrown inside a transaction undoes its writes and propagates', async () => {
      const driver = mariadbDriver(client);
      const boom = new Error('boom');
      let observed;

      await driver.explain(async (db) => {
        await rejects(
          db.transaction(async (tx) => {
            await tx.insert(widgets).values({ id: 204, name: 'doomed', quantity: 5 });
            throw boom;
          }),
          boom,
        );
        observed = await db.select({ id: widgets.id }).from(widgets).where(eq(widgets.id, 204));
      });

      deq(observed, []);
    });

    test('rolling back a nested transaction keeps the writes of the enclosing one', async () => {
      const driver = mariadbDriver(client);
      let observed;

      await driver.explain(async (db) => {
        await db.transaction(async (tx) => {
          await tx.insert(widgets).values({ id: 205, name: 'outer', quantity: 6 });
          await rejects(
            tx.transaction(async (inner) => {
              await inner.insert(widgets).values({ id: 206, name: 'inner', quantity: 7 });
              await inner.rollback();
            }),
            TransactionRollbackError,
          );
        });
        observed = await db.select({ id: widgets.id }).from(widgets).where(eq(widgets.name, 'outer'));
      });

      deq(observed, [{ id: 205 }]);
    });

    test('leaves the database unchanged after a committed transaction', async () => {
      const driver = mariadbDriver(client);

      await driver.explain((db) =>
        db.transaction((tx) => tx.insert(widgets).values({ id: 207, name: 'ephemeral', quantity: 8 })),
      );

      const [rows] = await client.query('SELECT COUNT(*) AS total FROM widgets WHERE id = 207');
      equal(Number(rows[0].total), 0);
    });
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
