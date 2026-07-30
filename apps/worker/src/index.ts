import { loadEnvironment } from '@sentinel/config';
import type { Task } from '@sentinel/contracts';
import { createDatabasePool, IdempotencyRepository, WorkflowRepository } from '@sentinel/database';

import { runBoundedWorker } from './bounded-worker.js';
import { createDefaultHandlerRegistry } from './ecommerce-handlers.js';
import {
  disablesHeartbeat,
  executeWithFailureInjection,
  InjectedWorkerCrashError,
  readFailureInjection,
} from './failure-injection.js';
import { executeLeasedTask } from './lease-executor.js';
import { RetryableTaskError } from './retry-policy.js';

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL, {
  maxConnections: environment.DATABASE_POOL_MAX,
});
const repository = new WorkflowRepository(database);
const idempotency = new IdempotencyRepository(database);
const handlers = createDefaultHandlerRegistry(idempotency);
let stopping = false;
let shutdownTimer: NodeJS.Timeout | null = null;

async function verifyDatabaseConnection(): Promise<void> {
  await database.query('SELECT 1');
  process.stdout.write(`[${environment.WORKER_ID}] PostgreSQL connection established\n`);
}

async function workerLoop(): Promise<void> {
  await runBoundedWorker({
    repository,
    workerId: environment.WORKER_ID,
    concurrency: environment.WORKER_CONCURRENCY,
    leaseDurationMs: environment.LEASE_DURATION_MS,
    pollIntervalMs: environment.WORKER_POLL_INTERVAL_MS,
    shouldStop: () => stopping,
    requestStop: (outcome) => {
      if (outcome === 'abandoned') {
        process.exitCode = 86;
      }
      beginStopping(
        outcome === 'abandoned'
          ? 'Injected crash requested worker shutdown'
          : 'Unexpected task execution failure requested worker shutdown',
      );
    },
    execute: executeTask,
    onClaim: (task, inFlight) => {
      process.stdout.write(
        `[${environment.WORKER_ID}] Claimed task ${task.id} at generation ${task.generation} (${inFlight}/${environment.WORKER_CONCURRENCY} slots)\n`,
      );
    },
    onOutcome: (task, outcome, inFlight) => {
      process.stdout.write(
        `[${environment.WORKER_ID}] Task ${task.id} finished with outcome ${outcome} (${inFlight}/${environment.WORKER_CONCURRENCY} slots)\n`,
      );
      if (outcome === 'abandoned') {
        process.stderr.write(
          `[${environment.WORKER_ID}] Injected crash abandoned task ${task.id}; lease recovery required\n`,
        );
      }
    },
    onError: (task, error) => {
      process.stderr.write(
        `[${environment.WORKER_ID}] Unexpected failure while executing ${task.id}: ${String(error)}\n`,
      );
    },
  });
}

async function executeTask(task: Task) {
  const failureInjection = readFailureInjection(task);
  return await executeLeasedTask({
    repository,
    task,
    workerId: environment.WORKER_ID,
    leaseDurationMs: environment.LEASE_DURATION_MS,
    heartbeatIntervalMs: environment.HEARTBEAT_INTERVAL_MS,
    execute: async (leasedTask) =>
      await executeWithFailureInjection(
        leasedTask,
        async (injectedTask) => await handlers.execute(injectedTask),
      ),
    heartbeatEnabled: !disablesHeartbeat(failureInjection),
    retryPolicy: {
      baseDelayMs: environment.RETRY_BASE_DELAY_MS,
      maxDelayMs: environment.RETRY_MAX_DELAY_MS,
      jitterRatio: environment.RETRY_JITTER_RATIO,
    },
    isRetryable: (error) => error instanceof RetryableTaskError,
    isAbandoned: (error) => error instanceof InjectedWorkerCrashError,
    onHeartbeatError: (error) => {
      process.stderr.write(
        `[${environment.WORKER_ID}] Lease heartbeat failed for ${task.id}: ${String(error)}\n`,
      );
    },
  });
}

function shutdown(signal: NodeJS.Signals): void {
  beginStopping(`Received ${signal}; shutting down`);
}

function beginStopping(message: string): void {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`[${environment.WORKER_ID}] ${message}\n`);
  shutdownTimer = setTimeout(() => {
    process.stderr.write(
      `[${environment.WORKER_ID}] Shutdown grace period expired; abandoning in-flight work\n`,
    );
    process.exit(process.exitCode || 1);
  }, environment.SHUTDOWN_GRACE_PERIOD_MS);
  shutdownTimer.unref();
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
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
  }
  await database.end();
}
