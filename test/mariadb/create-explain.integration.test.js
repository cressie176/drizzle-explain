const { equal, match, ok, rejects } = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { eq, relations } = require('drizzle-orm');
const { int, mysqlTable, varchar } = require('drizzle-orm/mysql-core');
const { createExplain, Operation } = require('../../lib');
const { mariadbDriver } = require('../../mariadb');
const { connect } = require('./connect');

const widgets = mysqlTable('widgets', {
  id: int('id').primaryKey(),
  name: varchar('name', { length: 64 }),
  quantity: int('quantity'),
});

const authors = mysqlTable('authors', {
  id: int('id').primaryKey(),
  name: varchar('name', { length: 64 }),
});

const books = mysqlTable('books', {
  id: int('id').primaryKey(),
  authorId: int('author_id'),
  title: varchar('title', { length: 64 }),
});

const authorsRelations = relations(authors, ({ many }) => ({ books: many(books) }));
const booksRelations = relations(books, ({ one }) => ({
  author: one(authors, { fields: [books.authorId], references: [authors.id] }),
}));
const relationalSchema = { authors, books, authorsRelations, booksRelations };

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

  test('checks every statement against the defaults when only a count is given', async () => {
    const explain = createExplain(mariadbDriver(client), { maxCost: 1000000 });

    const analysis = await explain((db) => findWidgetsStockedLike(db, 'b'), { statements: 2 });

    equal(analysis.passed, true, analysis.message);
    equal(analysis.statements.length, 2);
  });

  test('throws when the callback issues a different number of statements than the count', async () => {
    const explain = createExplain(mariadbDriver(client));

    await rejects(
      explain((db) => findWidgetsStockedLike(db, 'b'), { statements: 1 }),
      /expected 1 statements but 2 were executed/,
    );
  });

  test('throws when the callback issues more statements than limits supplied', async () => {
    const explain = createExplain(mariadbDriver(client));

    await rejects(
      explain((db) => findWidgetsStockedLike(db, 'b'), [{}]),
      /expected 1 statements but 2 were executed/,
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

describe('createExplain over the MariaDB driver with a relational schema', () => {
  let client;

  before(async () => {
    client = await connect();
    await client.query('DROP TABLE IF EXISTS books');
    await client.query('DROP TABLE IF EXISTS authors');
    await client.query('CREATE TABLE authors (id INT PRIMARY KEY, name VARCHAR(64))');
    await client.query('CREATE TABLE books (id INT PRIMARY KEY, author_id INT, title VARCHAR(64))');
    await client.query("INSERT INTO authors VALUES (1, 'alpha'), (2, 'beta')");
    await client.query("INSERT INTO books VALUES (1, 1, 'one'), (2, 1, 'two'), (3, 2, 'three')");
  });

  after(async () => {
    await client.query('DROP TABLE IF EXISTS books');
    await client.query('DROP TABLE IF EXISTS authors');
    await client.end();
  });

  // A nested `with` compiles to a LEFT JOIN LATERAL, which MariaDB cannot parse, so the
  // relational query here is a plain findMany: enough to prove the driver forwarded the
  // schema and populated db.query, without leaning on a join MariaDB does not support.
  test('explains a relational query when the schema is supplied to the driver', async () => {
    const explain = createExplain(mariadbDriver(client, { schema: relationalSchema }), { maxCost: 1000000 });

    const analysis = await explain((db) => db.query.authors.findMany({ where: eq(authors.id, 1) }));

    equal(analysis.passed, true, analysis.message);
    ok(analysis.plan);
  });
});
