import type { Task } from '@sentinel/contracts';
import { describe, expect, it, vi } from 'vitest';

import { runBoundedWorker } from './bounded-worker.js';
import type { LeaseExecutionOutcome } from './lease-executor.js';

describe('bounded worker scheduler', () => {
  it('never executes more tasks than its configured concurrency', async () => {
    const tasks = Array.from({ length: 7 }, (_, index) => createTask(index + 1));
    const repository = {
      claimTask: vi.fn(async () => tasks.shift() ?? null),
    };
    let stopping = false;
    let active = 0;
    let maximumActive = 0;
    let completed = 0;

    await runBoundedWorker({
      repository,
      workerId: 'bounded-worker',
      concurrency: 3,
      leaseDurationMs: 30_000,
      pollIntervalMs: 1,
      shouldStop: () => stopping,
      requestStop: () => {
        stopping = true;
      },
      execute: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return 'completed';
      },
      onOutcome: () => {
        completed += 1;
        if (completed === 7) stopping = true;
      },
    });

    expect(maximumActive).toBe(3);
    expect(completed).toBe(7);
  });

  it('stops claiming immediately and drains work already in flight', async () => {
    const tasks = [createTask(1), createTask(2), createTask(3)];
    const repository = {
      claimTask: vi.fn(async () => tasks.shift() ?? null),
    };
    let stopping = false;
    const completed: string[] = [];

    await runBoundedWorker({
      repository,
      workerId: 'draining-worker',
      concurrency: 2,
      leaseDurationMs: 30_000,
      pollIntervalMs: 1,
      shouldStop: () => stopping,
      requestStop: () => {
        stopping = true;
      },
      execute: async (task) => {
        stopping = true;
        await new Promise((resolve) => setTimeout(resolve, 2));
        completed.push(task.id);
        return 'completed';
      },
    });

    expect(repository.claimTask).toHaveBeenCalledTimes(1);
    expect(completed).toEqual(['task-1']);
  });

  it('stops the scheduler after an abandoned lease outcome', async () => {
    const repository = {
      claimTask: vi.fn().mockResolvedValueOnce(createTask(1)).mockResolvedValue(null),
    };
    let stopping = false;
    const requestStop = vi.fn((outcome: 'abandoned' | 'fatal') => {
      expect(outcome).toBe('abandoned');
      stopping = true;
    });

    await runBoundedWorker({
      repository,
      workerId: 'chaos-worker',
      concurrency: 1,
      leaseDurationMs: 30_000,
      pollIntervalMs: 1,
      shouldStop: () => stopping,
      requestStop,
      execute: async () => 'abandoned',
    });

    expect(requestStop).toHaveBeenCalledOnce();
    expect(repository.claimTask).toHaveBeenCalledOnce();
  });

  it('drains other leases and rethrows an unexpected execution failure', async () => {
    const tasks = [createTask(1), createTask(2)];
    const repository = {
      claimTask: vi.fn(async () => tasks.shift() ?? null),
    };
    let stopping = false;
    const outcomes: LeaseExecutionOutcome[] = [];

    await expect(
      runBoundedWorker({
        repository,
        workerId: 'failing-worker',
        concurrency: 2,
        leaseDurationMs: 30_000,
        pollIntervalMs: 1,
        shouldStop: () => stopping,
        requestStop: () => {
          stopping = true;
        },
        execute: async (task) => {
          if (task.id === 'task-1') throw new Error('database unavailable');
          await new Promise((resolve) => setTimeout(resolve, 2));
          outcomes.push('completed');
          return 'completed';
        },
      }),
    ).rejects.toThrow('database unavailable');
    expect(outcomes).toEqual(['completed']);
  });
});

function createTask(index: number): Task {
  const now = new Date('2026-07-30T00:00:00.000Z');
  return {
    id: `task-${index}`,
    workflowId: `workflow-${index}`,
    stepNumber: 1,
    name: 'Benchmark task',
    handler: 'noop',
    compensationHandler: null,
    executionMode: 'forward',
    status: 'leased',
    payload: {},
    result: null,
    maxAttempts: 5,
    attemptCount: 1,
    leaseOwner: 'bounded-worker',
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    generation: 1,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
