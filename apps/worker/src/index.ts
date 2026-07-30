import { setTimeout as delay } from 'node:timers/promises';

import { loadEnvironment } from '@sentinel/config';
import { createDatabasePool, WorkflowRepository } from '@sentinel/database';

import { executeLeasedTask } from './lease-executor.js';

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL);
const repository = new WorkflowRepository(database);
let stopping = false;

async function verifyDatabaseConnection(): Promise<void> {
  await database.query('SELECT 1');
  process.stdout.write(`[${environment.WORKER_ID}] PostgreSQL connection established\n`);
}

async function workerLoop(): Promise<void> {
  while (!stopping) {
    const task = await repository.claimTask({
      workerId: environment.WORKER_ID,
      leaseDurationMs: environment.LEASE_DURATION_MS,
    });

    if (!task) {
      await delay(environment.WORKER_POLL_INTERVAL_MS);
      continue;
    }

    process.stdout.write(
      `[${environment.WORKER_ID}] Claimed task ${task.id} at generation ${task.generation}\n`,
    );

    const outcome = await executeLeasedTask({
      repository,
      task,
      workerId: environment.WORKER_ID,
      leaseDurationMs: environment.LEASE_DURATION_MS,
      heartbeatIntervalMs: environment.HEARTBEAT_INTERVAL_MS,
      execute: async (leasedTask) => {
        // Phase 4 replaces this acknowledgement with registered workflow handlers.
        return {
          acknowledged: true,
          taskName: leasedTask.name,
        };
      },
      onHeartbeatError: (error) => {
        process.stderr.write(
          `[${environment.WORKER_ID}] Lease heartbeat failed for ${task.id}: ${String(error)}\n`,
        );
      },
    });

    process.stdout.write(
      `[${environment.WORKER_ID}] Task ${task.id} finished with outcome ${outcome}\n`,
    );
  }
}

function shutdown(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }

  stopping = true;
  process.stdout.write(`[${environment.WORKER_ID}] Received ${signal}; shutting down\n`);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

try {
  await verifyDatabaseConnection();
  await workerLoop();
} catch (error) {
  process.stderr.write(`[${environment.WORKER_ID}] Worker failed: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await database.end();
}
