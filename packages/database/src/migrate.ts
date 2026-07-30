import { loadEnvironment } from '@sentinel/config';
import { runMigrations } from './migrations.js';

const environment = loadEnvironment();

runMigrations({
  connectionString: environment.DATABASE_URL,
  onApplied: (migrationName) => process.stdout.write(`Applied migration ${migrationName}\n`),
}).catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${String(error)}\n`);
  process.exitCode = 1;
});
