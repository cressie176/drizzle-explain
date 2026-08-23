import type { Client, Pool } from 'pg';
import type { Driver } from './lib/index';

export function postgresDriver(client: Client | Pool): Driver;
