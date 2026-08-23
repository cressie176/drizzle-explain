import { Pool } from 'pg';

export function connect() {
  return new Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'drizzle_explain',
    password: process.env.PGPASSWORD ?? 'drizzle_explain',
    database: process.env.PGDATABASE ?? 'drizzle_explain',
  });
}
