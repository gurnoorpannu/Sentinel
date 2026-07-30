import type { Task } from '@sentinel/contracts';
import { describe, expect, it, vi } from 'vitest';

import { executeLeasedTask } from './lease-executor.js';

describe('lease-aware task execution', () => {
  it('completes using the claimed generation', async () => {
    const task = createLeasedTask();
    const repository = createRepository(task);

    const outcome = await executeLeasedTask({
      repository,
      task,
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      execute: async () => ({ accepted: true }),
    });

    expect(outcome).toBe('completed');
    expect(repository.completeTask).toHaveBeenCalledWith({
      taskId: task.id,
      workerId: 'worker-a',
      generation: 3,
      result: { accepted: true },
    });
    expect(repository.failTask).not.toHaveBeenCalled();
  });

  it('renews the lease while execution is still running', async () => {
    const task = createLeasedTask();
    let finishExecution: (() => void) | undefined;
    const repository = createRepository(task);
    repository.renewLease.mockImplementation(async () => {
      finishExecution?.();
      return task;
    });

    const outcome = await executeLeasedTask({
      repository,
      task,
      workerId: 'worker-a',
      leaseDurationMs: 100,
      heartbeatIntervalMs: 1,
      execute: async () => {
        await new Promise<void>((resolve) => {
          finishExecution = resolve;
        });
        return { accepted: true };
      },
    });

    expect(outcome).toBe('completed');
    expect(repository.renewLease).toHaveBeenCalled();
  });

  it('does not commit after a heartbeat reports that the lease was lost', async () => {
    const task = createLeasedTask();
    let finishExecution: (() => void) | undefined;
    const repository = createRepository(task);
    repository.renewLease.mockImplementation(async () => {
      finishExecution?.();
      return null;
    });

    const outcome = await executeLeasedTask({
      repository,
      task,
      workerId: 'worker-a',
      leaseDurationMs: 100,
      heartbeatIntervalMs: 1,
      execute: async () => {
        await new Promise<void>((resolve) => {
          finishExecution = resolve;
        });
        return { accepted: true };
      },
    });

    expect(outcome).toBe('fenced');
    expect(repository.completeTask).not.toHaveBeenCalled();
    expect(repository.failTask).not.toHaveBeenCalled();
  });

  it('records execution errors through the same generation fence', async () => {
    const task = createLeasedTask();
    const repository = createRepository(task);

    const outcome = await executeLeasedTask({
      repository,
      task,
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      execute: async () => {
        throw new Error('downstream unavailable');
      },
    });

    expect(outcome).toBe('failed');
    expect(repository.failTask).toHaveBeenCalledWith({
      taskId: task.id,
      workerId: 'worker-a',
      generation: 3,
      error: {
        name: 'Error',
        message: 'downstream unavailable',
      },
      retryable: false,
      retryDelayMs: expect.any(Number),
    });
    expect(repository.completeTask).not.toHaveBeenCalled();
  });

  it('schedules retryable errors with exponential backoff', async () => {
    const task = { ...createLeasedTask(), attemptCount: 2 };
    const repository = createRepository(task);
    repository.failTask.mockResolvedValue({ ...task, status: 'retry_scheduled' });

    const outcome = await executeLeasedTask({
      repository,
      task,
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      execute: async () => {
        throw new Error('temporary timeout');
      },
      isRetryable: () => true,
      retryPolicy: {
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
        jitterRatio: 0,
      },
    });

    expect(outcome).toBe('retry_scheduled');
    expect(repository.failTask).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: true,
        retryDelayMs: 2_000,
      }),
    );
  });
});

function createRepository(task: Task) {
  return {
    renewLease: vi.fn().mockResolvedValue(task),
    completeTask: vi.fn().mockResolvedValue({ ...task, status: 'completed' as const }),
    failTask: vi.fn().mockResolvedValue({ ...task, status: 'failed' as const }),
  };
}

function createLeasedTask(): Task {
  const now = new Date('2026-07-30T00:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workflowId: '00000000-0000-4000-8000-000000000010',
    stepNumber: 1,
    name: 'Charge payment',
    handler: 'charge-payment',
    status: 'leased',
    payload: { orderId: 'order-42' },
    result: null,
    maxAttempts: 5,
    attemptCount: 1,
    leaseOwner: 'worker-a',
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    generation: 3,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
