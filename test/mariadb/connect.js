const mysql = require('mysql2/promise');

function connect() {
  return mysql.createConnection({
    host: process.env.MARIADB_HOST ?? '127.0.0.1',
    port: Number(process.env.MARIADB_PORT ?? 3306),
    user: process.env.MARIADB_USER ?? 'drizzle_explain',
    password: process.env.MARIADB_PASSWORD ?? 'drizzle_explain',
    database: process.env.MARIADB_DATABASE ?? 'drizzle_explain',
    multipleStatements: true,
  });
}

module.exports = { connect };
