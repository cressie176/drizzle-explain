async function withRolledBackTransaction(client, body) {
  const lease = await acquireConnection(client);
  try {
    await lease.connection.beginTransaction();
    return await body(lease.connection);
  } finally {
    await rollBack(lease.connection);
    lease.release();
  }
}

function acquireConnection(client) {
  if (isPool(client)) return leaseFromPool(client);
  return leaseExistingConnection(client);
}

function isPool(client) {
  return typeof client.getConnection === 'function';
}

async function leaseFromPool(pool) {
  const connection = await pool.getConnection();
  return { connection, release: () => connection.release() };
}

function leaseExistingConnection(client) {
  return { connection: client, release: () => {} };
}

async function rollBack(connection) {
  await connection.rollback();
}

module.exports = { withRolledBackTransaction };
