import type { Task } from '@sentinel/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  disablesHeartbeat,
  executeWithFailureInjection,
  InjectedWorkerCrashError,
  InvalidFailureInjectionError,
  readFailureInjection,
} from './failure-injection.js';
import { RetryableTaskError } from './retry-policy.js';

describe('deterministic worker failure injection', () => {
  it('injects retryable failures only for the configured attempts', async () => {
    const execute = vi.fn().mockResolvedValue({ accepted: true });
    const task = createTask({ mode: 'retryable', attempts: 2 });

    await expect(executeWithFailureInjection(task, execute)).rejects.toBeInstanceOf(
      RetryableTaskError,
    );
    await expect(
      executeWithFailureInjection({ ...task, attemptCount: 3 }, execute),
    ).resolves.toEqual({ accepted: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('can crash after an external effect without returning its result', async () => {
    const execute = vi.fn().mockResolvedValue({ chargeId: 'charge-order-42' });
    const task = createTask({ mode: 'crash_after_effect' });

    await expect(executeWithFailureInjection(task, execute)).rejects.toMatchObject({
      name: 'InjectedWorkerCrashError',
      mode: 'crash_after_effect',
      taskId: task.id,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('delays a hang while disabling lease heartbeats', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ accepted: true });
    const task = createTask({ mode: 'hang', delayMs: 45_000 });
    const plan = readFailureInjection(task);

    await expect(executeWithFailureInjection(task, execute, sleep)).resolves.toEqual({
      accepted: true,
    });
    expect(disablesHeartbeat(plan)).toBe(true);
    expect(sleep).toHaveBeenCalledWith(45_000);
  });

  it('rejects malformed failure plans instead of injecting ambiguous behavior', () => {
    const task = createTask({ mode: 'unknown' });

    expect(() => readFailureInjection(task)).toThrow(InvalidFailureInjectionError);
  });

  it('identifies injected crash errors for lease abandonment', () => {
    expect(new InjectedWorkerCrashError('crash_before_effect', 'task-1')).toMatchObject({
      mode: 'crash_before_effect',
      taskId: 'task-1',
    });
  });
});

function createTask(sentinelFailure: Record<string, unknown>): Task {
  const now = new Date('2026-07-30T00:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workflowId: '00000000-0000-4000-8000-000000000010',
    stepNumber: 2,
    name: 'Charge payment',
    handler: 'charge-payment',
    compensationHandler: 'refund-payment',
    executionMode: 'forward',
    status: 'leased',
    payload: { orderId: 'order-42', sentinelFailure } as Task['payload'],
    result: null,
    maxAttempts: 5,
    attemptCount: 1,
    leaseOwner: 'chaos-worker',
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    generation: 1,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
