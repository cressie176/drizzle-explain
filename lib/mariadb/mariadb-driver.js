const { drizzle } = require('drizzle-orm/mysql-proxy');
const { createStatementSequencer, runToCompletion } = require('../statement-sequencer');
const { withDiscardedEffects } = require('./discarded-effects');
const { supportTransactions } = require('../savepoint-transactions');
const { translatePlan } = require('./plan-translator');

function mariadbDriver(client, config) {
  return { explain: (run) => explainWithin(client, config, run) };
}

async function explainWithin(client, config, run) {
  const statements = [];
  const sequencer = createStatementSequencer();
  const db = instrumentedDatabase(client, config, statements, sequencer);
  await client.beginTransaction();
  try {
    await runToCompletion(run, db, sequencer);
  } finally {
    await client.rollback();
  }
  return statements;
}

function instrumentedDatabase(client, config, statements, sequencer) {
  const db = drizzle(transparentProxy(client, statements, sequencer), config);
  return supportTransactions(db, (sql) => client.query(sql), sequencer);
}

function transparentProxy(client, statements, sequencer) {
  return (sql, params, method) => sequencer.enqueue(() => analyseAndExecute(client, statements, sql, params, method));
}

async function analyseAndExecute(client, statements, sql, params, method) {
  statements.push(await analyseStatement(client, sql, params));
  return executeStatement(client, sql, params, method);
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
