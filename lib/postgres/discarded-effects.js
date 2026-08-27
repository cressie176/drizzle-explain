const SAVEPOINT = 'drizzle_explain';

async function withDiscardedEffects(connection, body) {
  await connection.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    return await body();
  } finally {
    await discard(connection);
  }
}

async function discard(connection) {
  await connection.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
  await connection.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
}

module.exports = { withDiscardedEffects };
