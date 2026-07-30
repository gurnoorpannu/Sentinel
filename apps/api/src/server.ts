import { loadEnvironment } from '@sentinel/config';
import { createDatabasePool, WorkflowRepository } from '@sentinel/database';

import { buildApp } from './app.js';

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL);
const workflows = new WorkflowRepository(database);
const app = buildApp({
  database,
  workflows,
  logger: { level: environment.LOG_LEVEL },
  chaosEnabled: environment.CHAOS_MODE_ENABLED,
});

app.addHook('onClose', async () => {
  await database.end();
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down Sentinel API');
  await app.close();
  process.exit(0);
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
