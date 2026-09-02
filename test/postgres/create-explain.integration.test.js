const { equal, deepEqual: deq, match, ok, rejects } = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { eq, relations } = require('drizzle-orm');
const { integer, pgTable, text } = require('drizzle-orm/pg-core');
const { createExplain, Operation } = require('../../lib');
const { postgresDriver } = require('../../postgres');
const { connect } = require('./connect');

const widgets = pgTable('widgets', {
  id: integer('id'),
  name: text('name'),
});

const authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name'),
});

const books = pgTable('books', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id'),
  title: text('title'),
});

const authorsRelations = relations(authors, ({ many }) => ({ books: many(books) }));
const booksRelations = relations(books, ({ one }) => ({
  author: one(authors, { fields: [books.authorId], references: [authors.id] }),
}));
const relationalSchema = { authors, books, authorsRelations, booksRelations };

async function findWidgetIdByName(db, name) {
  const [found] = await db.select({ id: widgets.id }).from(widgets).where(eq(widgets.name, name));
  return found.id;
}

async function findWidgetNamedLike(db, name) {
  const id = await findWidgetIdByName(db, name);
  return db.select().from(widgets).where(eq(widgets.id, id));
}

describe('createExplain over the PostgreSQL driver', () => {
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

  test('passes a cheap query and reports the raw plan', async () => {
    const explain = createExplain(postgresDriver(pool), { maxCost: 1000000 });

    const analysis = await explain((db) => db.select().from(widgets).where(eq(widgets.id, 2)));

    equal(analysis.passed, true, analysis.message);
    equal(analysis.message, '');
    ok(Array.isArray(analysis.plan));
  });

  test('fails when the plan cost exceeds a tight maxCost', async () => {
    const explain = createExplain(postgresDriver(pool), { maxCost: 0 });

    const analysis = await explain((db) => db.select().from(widgets));

    equal(analysis.passed, false);
    match(analysis.message, /exceeds limit 0/);
  });

  test('fails when the plan runs a disallowed operation', async () => {
    const explain = createExplain(postgresDriver(pool), { disallowOperations: [Operation.SEQ_SCAN] });

    const analysis = await explain((db) => db.select().from(widgets));

    equal(analysis.passed, false);
    match(analysis.message, /disallowed operation: Seq Scan/);
  });

  test('a per-call allowOperations override permits an otherwise-disallowed operation', async () => {
    const explain = createExplain(postgresDriver(pool), { disallowOperations: [Operation.SEQ_SCAN] });

    const analysis = await explain((db) => db.select().from(widgets), { allowOperations: [Operation.SEQ_SCAN] });

    equal(analysis.passed, true, analysis.message);
  });

  test('analyses every statement a public query function issues', async () => {
    const explain = createExplain(postgresDriver(pool), { maxCost: 1000000 });

    const analysis = await explain((db) => findWidgetNamedLike(db, 'beta'), [{}, {}]);

    equal(analysis.passed, true, analysis.message);
    equal(analysis.statements.length, 2);
  });

  test('a dependent statement is explained with the parameters its predecessor produced', async () => {
    const explain = createExplain(postgresDriver(pool));

    const analysis = await explain((db) => findWidgetNamedLike(db, 'gamma'), [{ maxCost: 1000000 }, { maxCost: 0 }]);

    match(analysis.message, /params: \[3\]/);
  });

  test('names the offending statement when one of several breaches its limits', async () => {
    const explain = createExplain(postgresDriver(pool));

    const analysis = await explain((db) => findWidgetNamedLike(db, 'beta'), [{ maxCost: 1000000 }, { maxCost: 0 }]);

    equal(analysis.passed, false);
    match(analysis.message, /statement 2 of 2/);
    match(analysis.message, /exceeds limit 0/);
    equal(analysis.statements[0].passed, true);
  });

  test('checks every statement against the defaults when only a count is given', async () => {
    const explain = createExplain(postgresDriver(pool), { maxCost: 1000000 });

    const analysis = await explain((db) => findWidgetNamedLike(db, 'beta'), { statements: 2 });

    equal(analysis.passed, true, analysis.message);
    equal(analysis.statements.length, 2);
  });

  test('throws when the callback issues a different number of statements than the count', async () => {
    const explain = createExplain(postgresDriver(pool));

    await rejects(
      explain((db) => findWidgetNamedLike(db, 'beta'), { statements: 1 }),
      /expected 1 statements but 2 were executed/,
    );
  });

  test('throws when the callback issues more statements than limits supplied', async () => {
    const explain = createExplain(postgresDriver(pool));

    await rejects(
      explain((db) => findWidgetNamedLike(db, 'beta'), [{}]),
      /expected 1 statements but 2 were executed/,
    );
  });

  test('analyses a Promise.all of a write and an independent read with distinct limits', async () => {
    const explain = createExplain(postgresDriver(pool), { maxCost: 1000000 });

    const analysis = await explain(
      (db) =>
        Promise.all([
          db.insert(widgets).values({ id: 60, name: 'concurrent' }),
          db.select().from(widgets).where(eq(widgets.id, 1)),
        ]),
      [{}, { maxCost: 0 }],
    );

    equal(analysis.passed, false);
    equal(analysis.statements[0].passed, true);
    equal(analysis.statements[1].passed, false);
    match(analysis.message, /statement 2 of 2/);

    const { rows } = await pool.query('SELECT id FROM widgets WHERE id = 60');
    deq(rows, []);
  });

  test('rolls back a write executed through the query callback', async () => {
    const explain = createExplain(postgresDriver(pool));

    await explain((db) => db.insert(widgets).values({ id: 42, name: 'ephemeral' }));

    const { rows } = await pool.query('SELECT id FROM widgets WHERE id = 42');
    deq(rows, []);
  });
});

describe('createExplain over the PostgreSQL driver with a relational schema', () => {
  let pool;

  before(async () => {
    pool = connect();
    await pool.query('DROP TABLE IF EXISTS books, authors');
    await pool.query('CREATE TABLE authors (id integer PRIMARY KEY, name text)');
    await pool.query('CREATE TABLE books (id integer PRIMARY KEY, author_id integer, title text)');
    await pool.query("INSERT INTO authors (id, name) VALUES (1, 'alpha'), (2, 'beta')");
    await pool.query("INSERT INTO books (id, author_id, title) VALUES (1, 1, 'one'), (2, 1, 'two'), (3, 2, 'three')");
  });

  after(async () => {
    await pool.query('DROP TABLE IF EXISTS books, authors');
    await pool.end();
  });

  test('explains a relational query when the schema is supplied to the driver', async () => {
    const explain = createExplain(postgresDriver(pool, { schema: relationalSchema }), { maxCost: 1000000 });

    const analysis = await explain((db) => db.query.authors.findMany({ with: { books: true } }));

    equal(analysis.passed, true, analysis.message);
    ok(Array.isArray(analysis.plan));
  });
});
