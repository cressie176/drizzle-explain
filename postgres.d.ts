import type { Client, Pool } from 'pg';
import type { Driver } from './lib/index';

/**
 * @param config the Drizzle config forwarded to `drizzle()` when building the
 * instrumented database. Pass `{ schema }` (drizzle 0.x) or `{ relations }`
 * (drizzle 1.x) so a callback using the relational query builder (`db.query.*`)
 * can be explained. Parameterize `TDatabase` to type the callback's `db`.
 */
export function postgresDriver<TDatabase = unknown>(
  client: Client | Pool,
  config?: Record<string, unknown>,
): Driver<TDatabase>;
