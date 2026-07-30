import { createHash } from 'node:crypto';

import type { JsonObject, JsonValue } from '@sentinel/contracts';
import type { Pool, QueryResultRow } from 'pg';

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response: JsonValue;
}

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency key "${key}" was reused with a different request`);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyRepository {
  constructor(private readonly pool: Pool) {}

  async execute(input: {
    key: string;
    operation: string;
    request: JsonObject;
    produce: () => Promise<JsonValue>;
  }): Promise<{ response: JsonValue; replayed: boolean }> {
    const requestHash = createHash('sha256').update(JSON.stringify(input.request)).digest('hex');
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.key]);
      const existing = await client.query<IdempotencyRow>(
        'SELECT request_hash, response FROM idempotency_records WHERE key = $1',
        [input.key],
      );
      const row = existing.rows[0];

      if (row) {
        if (row.request_hash !== requestHash) {
          throw new IdempotencyConflictError(input.key);
        }
        await client.query('COMMIT');
        return { response: row.response, replayed: true };
      }

      const response = await input.produce();
      await client.query(
        `
          INSERT INTO idempotency_records (key, operation, request_hash, response)
          VALUES ($1, $2, $3, $4::jsonb)
        `,
        [input.key, input.operation, requestHash, JSON.stringify(response)],
      );
      await client.query('COMMIT');
      return { response, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
