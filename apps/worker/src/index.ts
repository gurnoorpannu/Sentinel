import { loadEnvironment } from '@sentinel/config';
import { createDatabasePool } from '@sentinel/database';

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL);
let stopping = false;

async function verifyDatabaseConnection(): Promise<void> {
  await database.query('SELECT 1');
  process.stdout.write(`[${environment.WORKER_ID}] PostgreSQL connection established\n`);
}

async function workerLoop(): Promise<void> {
  while (!stopping) {
    // Task claiming is introduced in Phase 3. This heartbeat proves that the
    // worker process and its durable database dependency are operational.
    await new Promise((resolve) => setTimeout(resolve, environment.WORKER_POLL_INTERVAL_MS));
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) {
    return;
  }

  stopping = true;
  process.stdout.write(`[${environment.WORKER_ID}] Received ${signal}; shutting down\n`);
  await database.end();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await verifyDatabaseConnection();
  await workerLoop();
} catch (error) {
  process.stderr.write(`[${environment.WORKER_ID}] Worker failed: ${String(error)}\n`);
  await database.end();
  process.exitCode = 1;
}
