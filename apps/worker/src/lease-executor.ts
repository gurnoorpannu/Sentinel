import { setTimeout as delay } from 'node:timers/promises';

import type { JsonObject, JsonValue, Task } from '@sentinel/contracts';
import type { WorkflowRepository } from '@sentinel/database';

import { calculateBackoff, type RetryPolicy } from './retry-policy.js';

type LeaseStore = Pick<WorkflowRepository, 'renewLease' | 'completeTask' | 'failTask'>;

export type LeaseExecutionOutcome =
  'completed' | 'retry_scheduled' | 'failed' | 'fenced' | 'abandoned';

interface ExecuteLeasedTaskOptions {
  repository: LeaseStore;
  task: Task;
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  execute: (task: Task) => Promise<JsonValue>;
  onHeartbeatError?: (error: unknown) => void;
  retryPolicy?: RetryPolicy;
  isRetryable?: (error: unknown) => boolean;
  isAbandoned?: (error: unknown) => boolean;
  heartbeatEnabled?: boolean;
}

export async function executeLeasedTask({
  repository,
  task,
  workerId,
  leaseDurationMs,
  heartbeatIntervalMs,
  execute,
  onHeartbeatError,
  retryPolicy = {
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
  },
  isRetryable = () => false,
  isAbandoned = () => false,
  heartbeatEnabled = true,
}: ExecuteLeasedTaskOptions): Promise<LeaseExecutionOutcome> {
  const heartbeatController = new AbortController();
  const heartbeat = heartbeatEnabled
    ? maintainLease({
        repository,
        task,
        workerId,
        leaseDurationMs,
        heartbeatIntervalMs,
        signal: heartbeatController.signal,
      }).catch((error: unknown) => {
        onHeartbeatError?.(error);
        return false;
      })
    : Promise.resolve(true);

  let result: JsonValue | undefined;
  let executionError: unknown;

  try {
    result = await execute(task);
  } catch (error) {
    executionError = error;
  } finally {
    heartbeatController.abort();
  }

  const leaseRemainedCurrent = await heartbeat;
  if (executionError !== undefined && isAbandoned(executionError)) {
    return 'abandoned';
  }
  if (!leaseRemainedCurrent) {
    return 'fenced';
  }

  if (executionError !== undefined) {
    const failed = await repository.failTask({
      taskId: task.id,
      workerId,
      generation: task.generation,
      error: serializeError(executionError),
      retryable: isRetryable(executionError),
      retryDelayMs: calculateBackoff(task.attemptCount, retryPolicy),
    });
    return failed ? (failed.status === 'retry_scheduled' ? 'retry_scheduled' : 'failed') : 'fenced';
  }

  const completed = await repository.completeTask({
    taskId: task.id,
    workerId,
    generation: task.generation,
    result: result ?? null,
  });
  return completed ? 'completed' : 'fenced';
}

interface MaintainLeaseOptions {
  repository: LeaseStore;
  task: Task;
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  signal: AbortSignal;
}

async function maintainLease({
  repository,
  task,
  workerId,
  leaseDurationMs,
  heartbeatIntervalMs,
  signal,
}: MaintainLeaseOptions): Promise<boolean> {
  while (!signal.aborted) {
    try {
      await delay(heartbeatIntervalMs, undefined, { signal });
    } catch (error) {
      if (signal.aborted && error instanceof Error && error.name === 'AbortError') {
        return true;
      }
      throw error;
    }

    const renewed = await repository.renewLease({
      taskId: task.id,
      workerId,
      generation: task.generation,
      leaseDurationMs,
    });
    if (!renewed) {
      return false;
    }
  }

  return true;
}

function serializeError(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: 'UnknownError',
    message: String(error),
  };
}
