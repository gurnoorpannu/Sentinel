import { loadEnvironment } from '@sentinel/config';
import { createDatabasePool, WorkflowRepository } from '@sentinel/database';

import { buildApp } from './app.js';

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL, {
  maxConnections: environment.DATABASE_POOL_MAX,
});
const workflows = new WorkflowRepository(database);
let shuttingDown = false;
const app = buildApp({
  database,
  workflows,
  logger: { level: environment.LOG_LEVEL },
  chaosEnabled: environment.CHAOS_MODE_ENABLED,
  isShuttingDown: () => shuttingDown,
  requestTimeoutMs: environment.API_REQUEST_TIMEOUT_MS,
  keepAliveTimeoutMs: environment.API_KEEP_ALIVE_TIMEOUT_MS,
  metricsToken: environment.METRICS_TOKEN,
  operatorToken: environment.OPERATOR_TOKEN,
});

app.addHook('onClose', async () => {
  await database.end();
});

let shutdownPromise: Promise<void> | null = null;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down Sentinel API');
  shutdownPromise = closeWithinGracePeriod();
  return shutdownPromise;
}

async function closeWithinGracePeriod(): Promise<void> {
  const timeout = setTimeout(() => {
    app.log.error('API shutdown grace period expired');
    process.exitCode = 1;
    app.server.closeAllConnections();
  }, environment.SHUTDOWN_GRACE_PERIOD_MS);
  timeout.unref();

  try {
    await app.close();
  } finally {
    clearTimeout(timeout);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({
    host: environment.API_HOST,
    port: environment.API_PORT,
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
