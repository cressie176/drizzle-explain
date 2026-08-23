const { drizzle } = require('drizzle-orm/mysql-proxy');
const { translatePlan } = require('./plan-translator');

function mariadbDriver(client) {
  return { explain: (run) => explainWithin(client, run) };
}

async function explainWithin(client, run) {
  const statements = [];
  const db = instrumentedDatabase(client, statements);
  await client.beginTransaction();
  try {
    await run(db);
  } finally {
    await client.rollback();
  }
  return statements;
}

function instrumentedDatabase(client, statements) {
  return drizzle(async (sql, params) => {
    statements.push(await analyseStatement(client, sql, params));
    return emptyResult();
  });
}

async function analyseStatement(client, sql, params) {
  const [rows] = await client.query(`ANALYZE FORMAT=JSON ${sql}`, params);
  const plan = JSON.parse(rows[0].ANALYZE);
  return { plan, root: translatePlan(plan) };
}

function emptyResult() {
  return { rows: [{}], insertId: 0, affectedRows: 0 };
}

module.exports = { mariadbDriver };
