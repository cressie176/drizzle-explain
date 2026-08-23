async function withRolledBackTransaction(client, body) {
  const lease = await acquireConnection(client);
  try {
    await lease.connection.query('BEGIN');
    return await body(lease.connection);
  } finally {
    await rollBack(lease.connection);
    lease.release();
  }
}

function acquireConnection(client) {
  if (isPool(client)) return leaseFromPool(client);
  return leaseExistingClient(client);
}

function isPool(client) {
  return 'totalCount' in client;
}

async function leaseFromPool(pool) {
  const connection = await pool.connect();
  return { connection, release: () => connection.release() };
}

function leaseExistingClient(client) {
  return { connection: client, release: () => {} };
}

async function rollBack(connection) {
  await connection.query('ROLLBACK');
}

module.exports = { withRolledBackTransaction };
