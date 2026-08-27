const { drizzle } = require('drizzle-orm/mysql-proxy');
const { withDiscardedEffects } = require('./discarded-effects');
const { translatePlan } = require('./plan-translator');

function mariadbDriver(client) {
  return { explain: (run) => explainWithin(client, run) };
}

async function explainWithin(client, run) {
  const statements = [];
  const db = drizzle(transparentProxy(client, statements));
  await client.beginTransaction();
  try {
    await run(db);
  } finally {
    await client.rollback();
  }
  return statements;
}

function transparentProxy(client, statements) {
  return async (sql, params, method) => {
    statements.push(await analyseStatement(client, sql, params));
    return executeStatement(client, sql, params, method);
  };
}

async function analyseStatement(client, sql, params) {
  const plan = await withDiscardedEffects(client, () => analyseQuery(client, sql, params));
  return { sql, params, plan, root: translatePlan(plan) };
}

async function analyseQuery(client, sql, params) {
  const [rows] = await client.query(`ANALYZE FORMAT=JSON ${sql}`, params);
  return JSON.parse(rows[0].ANALYZE);
}

function executeStatement(client, sql, params, method) {
  return executors[method](client, sql, params);
}

async function executeAsPositionalRows(client, sql, params) {
  const [rows] = await client.query({ sql, values: params, rowsAsArray: true });
  return { rows };
}

async function executeAsSummary(client, sql, params) {
  const result = await client.query({ sql, values: params });
  return { rows: result };
}

const executors = {
  all: executeAsPositionalRows,
  execute: executeAsSummary,
};

module.exports = { mariadbDriver };
