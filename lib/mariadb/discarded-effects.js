const SAVEPOINT = 'drizzle_explain';

async function withDiscardedEffects(client, body) {
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    return await body();
  } finally {
    await discard(client);
  }
}

async function discard(client) {
  await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
  await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
}

module.exports = { withDiscardedEffects };
