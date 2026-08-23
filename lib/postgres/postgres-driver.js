const { drizzle } = require('drizzle-orm/pg-proxy');
const { withRolledBackTransaction } = require('./rolled-back-transaction');
const { translatePlan } = require('./translate-plan');

function postgresDriver(client) {
  return { explain: (run) => explainStatements(client, run) };
}

function explainStatements(client, run) {
  return withRolledBackTransaction(client, async (connection) => {
    const statements = [];
    const db = drizzle(explainingProxy(connection, statements));
    await run(db);
    return statements;
  });
}

function explainingProxy(connection, statements) {
  return async (query, params) => {
    const rawPlan = await explainQuery(connection, query, params);
    statements.push(toExplainedStatement(rawPlan));
    return { rows: [] };
  };
}

async function explainQuery(connection, query, params) {
  const result = await connection.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, params);
  return result.rows[0]['QUERY PLAN'];
}

function toExplainedStatement(rawPlan) {
  return { plan: rawPlan, root: translatePlan(rawPlan) };
}

module.exports = { postgresDriver };
