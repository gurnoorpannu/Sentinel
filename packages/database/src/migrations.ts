import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pg from 'pg';

const { Client } = pg;

interface MigrationOptions {
  connectionString: string;
  migrationsDirectory?: string;
  onApplied?: (migrationName: string) => void;
}

export async function runMigrations({
  connectionString,
  migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url)),
  onApplied,
}: MigrationOptions): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const migrationFile of migrationFiles) {
      const existing = await client.query<{ name: string }>(
        'SELECT name FROM schema_migrations WHERE name = $1',
        [migrationFile],
      );

      if (existing.rowCount !== 0) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDirectory, migrationFile), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migrationFile]);
        await client.query('COMMIT');
        onApplied?.(migrationFile);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}
