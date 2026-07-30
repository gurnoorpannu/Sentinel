import { performance } from 'node:perf_hooks';
import process from 'node:process';

import {
  createDatabasePool,
  runMigrations,
  WorkflowRepository,
} from '../packages/database/dist/index.js';
import { runBoundedWorker } from '../apps/worker/dist/bounded-worker.js';

const connectionString = process.env.BENCHMARK_DATABASE_URL;
if (!connectionString) {
  throw new Error('BENCHMARK_DATABASE_URL must point to an isolated PostgreSQL database');
}

const taskCount = integerSetting('BENCHMARK_TASKS', 250, 1, 10_000);
const concurrency = integerSetting('BENCHMARK_CONCURRENCY', 8, 1, 64);
const pool = createDatabasePool(connectionString, {
  maxConnections: Math.max(10, concurrency + 2),
});
const repository = new WorkflowRepository(pool);
const workflowIds = [];
const claimLatencies = [];
let stopping = false;
let completed = 0;

try {
  await runMigrations({ connectionString });
  const creationStarted = performance.now();
  for (let index = 0; index < taskCount; index += 1) {
    const created = await repository.createWorkflow({
      name: `Benchmark ${process.pid}-${index + 1}`,
      payload: { benchmark: true, processId: process.pid, sequence: index + 1 },
      steps: [{ name: 'No-op benchmark step', handler: 'noop', maxAttempts: 1 }],
    });
    workflowIds.push(created.workflow.id);
  }
  const creationDurationMs = performance.now() - creationStarted;

  const executionStarted = performance.now();
  await runBoundedWorker({
    repository,
    workerId: `benchmark-${process.pid}`,
    concurrency,
    leaseDurationMs: 30_000,
    pollIntervalMs: 1,
    shouldStop: () => stopping,
    requestStop: () => {
      stopping = true;
    },
    execute: async (task) => {
      const settled = await repository.completeTask({
        taskId: task.id,
        workerId: `benchmark-${process.pid}`,
        generation: task.generation,
        result: { benchmark: true },
      });
      if (!settled) {
        throw new Error(`Benchmark task ${task.id} was fenced unexpectedly`);
      }
      return 'completed';
    },
    onClaim: (task) => {
      claimLatencies.push(Date.now() - task.createdAt.getTime());
    },
    onOutcome: () => {
      completed += 1;
      if (completed === taskCount) {
        stopping = true;
      }
    },
  });
  const executionDurationMs = performance.now() - executionStarted;

  process.stdout.write(
    `${JSON.stringify(
      {
        tasks: taskCount,
        concurrency,
        setupSeconds: rounded(creationDurationMs / 1_000),
        executionSeconds: rounded(executionDurationMs / 1_000),
        tasksPerSecond: rounded(taskCount / (executionDurationMs / 1_000)),
        claimLatencyMs: {
          p50: percentile(claimLatencies, 0.5),
          p95: percentile(claimLatencies, 0.95),
          max: Math.max(...claimLatencies),
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (workflowIds.length > 0) {
    await pool.query('DELETE FROM workflows WHERE id = ANY($1::uuid[])', [workflowIds]);
  }
  await pool.end();
}

function integerSetting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function rounded(value) {
  return Number(value.toFixed(2));
}
