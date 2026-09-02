const { TransactionRollbackError } = require('drizzle-orm');

function supportTransactions(db, execute, sequencer) {
  let savepoints = 0;
  const run = (sql) => sequencer.enqueue(() => execute(sql));
  db.transaction = (body) => withSavepoint(run, `drizzle_explain_tx_${++savepoints}`, () => body(db));
  db.rollback = abort;
  return db;
}

async function withSavepoint(run, savepoint, body) {
  await run(`SAVEPOINT ${savepoint}`);
  try {
    const result = await body();
    await release(run, savepoint);
    return result;
  } catch (error) {
    await discard(run, savepoint);
    throw error;
  }
}

async function discard(run, savepoint) {
  await run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await release(run, savepoint);
}

function release(run, savepoint) {
  return run(`RELEASE SAVEPOINT ${savepoint}`);
}

function abort() {
  throw new TransactionRollbackError();
}

module.exports = { supportTransactions };
