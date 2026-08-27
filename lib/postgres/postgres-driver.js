const { drizzle } = require('drizzle-orm/pg-proxy');
const { createStatementSequencer, runToCompletion } = require('../statement-sequencer');
const { withRolledBackTransaction } = require('./rolled-back-transaction');
const { withDiscardedEffects } = require('./discarded-effects');
const { translatePlan } = require('./translate-plan');

function postgresDriver(client) {
  return { explain: (run) => explainStatements(client, run) };
}

function explainStatements(client, run) {
  return withRolledBackTransaction(client, async (connection) => {
    const statements = [];
    const sequencer = createStatementSequencer();
    const db = drizzle(transparentProxy(connection, statements, sequencer));
    await runToCompletion(run, db, sequencer);
    return statements;
  });
}

function transparentProxy(connection, statements, sequencer) {
  return (sql, params, method) =>
    sequencer.enqueue(() => explainAndExecute(connection, statements, sql, params, method));
}

async function explainAndExecute(connection, statements, sql, params, method) {
  statements.push(await explainStatement(connection, sql, params));
  return executeStatement(connection, sql, params, method);
}

async function explainStatement(connection, sql, params) {
  const plan = await withDiscardedEffects(connection, () => explainQuery(connection, sql, params));
  return { sql, params, plan, root: translatePlan(plan) };
}

async function explainQuery(connection, sql, params) {
  const result = await connection.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
  return result.rows[0]['QUERY PLAN'];
}

function executeStatement(connection, sql, params, method) {
  return executors[method](connection, sql, params);
}

async function executeAsPositionalRows(connection, sql, params) {
  const result = await connection.query({ text: sql, values: params, rowMode: 'array' });
  return { rows: result.rows };
}

async function executeAsNamedRows(connection, sql, params) {
  const result = await connection.query({ text: sql, values: params });
  return { rows: result.rows };
}

const executors = {
  all: executeAsPositionalRows,
  execute: executeAsNamedRows,
};

module.exports = { postgresDriver };
