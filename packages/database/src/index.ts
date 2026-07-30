import { Pool } from 'pg';

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    application_name: 'sentinel',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export type { Pool };
