import type { JsonObject } from '@sentinel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDatabasePool,
  IdempotencyConflictError,
  IdempotencyRepository,
  type Pool,
} from './index.js';
import { runMigrations } from './migrations.js';
import { InvalidStateTransitionError, WorkflowRepository } from './workflow-repository.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase('WorkflowRepository with PostgreSQL', () => {
  let pool: Pool;
  let repository: WorkflowRepository;
  let idempotency: IdempotencyRepository;

  beforeAll(async () => {
    if (!testDatabaseUrl) {
      throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
    }

    await runMigrations({ connectionString: testDatabaseUrl });
    pool = createDatabasePool(testDatabaseUrl);
    repository = new WorkflowRepository(pool);
    idempotency = new IdempotencyRepository(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE idempotency_records, workflow_events, tasks, workflows RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('atomically creates an ordered workflow with an append-only event history', async () => {
    const detail = await repository.createWorkflow({
      name: 'Order fulfillment',
      payload: { orderId: 'order-42' },
      steps: [
        { name: 'Validate order' },
        { name: 'Charge payment', maxAttempts: 3 },
        { name: 'Reserve inventory' },
        { name: 'Send confirmation' },
      ],
    });

    expect(detail.workflow).toMatchObject({
      name: 'Order fulfillment',
      status: 'pending',
      payload: { orderId: 'order-42' },
      version: 1,
    });
    expect(
      detail.tasks.map(({ stepNumber, name, status }) => ({ stepNumber, name, status })),
    ).toEqual([
      { stepNumber: 1, name: 'Validate order', status: 'ready' },
      { stepNumber: 2, name: 'Charge payment', status: 'blocked' },
      { stepNumber: 3, name: 'Reserve inventory', status: 'blocked' },
      { stepNumber: 4, name: 'Send confirmation', status: 'blocked' },
    ]);
    expect(detail.events.map(({ sequence, eventType }) => ({ sequence, eventType }))).toEqual([
      { sequence: 1, eventType: 'workflow.created' },
      { sequence: 2, eventType: 'task.created' },
      { sequence: 3, eventType: 'task.created' },
      { sequence: 4, eventType: 'task.created' },
      { sequence: 5, eventType: 'task.created' },
    ]);

    const reloaded = await repository.getWorkflow(detail.workflow.id);
    expect(reloaded).toEqual(detail);
  });

  it('returns null when a workflow does not exist', async () => {
    await expect(
      repository.getWorkflow('00000000-0000-4000-8000-000000000099'),
    ).resolves.toBeNull();
  });

  it('lists recent workflows with dashboard task counts and status filtering', async () => {
    const running = await repository.createWorkflow({
      name: 'Running order',
      steps: [{ name: 'Validate' }, { name: 'Charge' }],
    });
    const pending = await repository.createWorkflow({
      name: 'Pending order',
      steps: [{ name: 'Validate' }, { name: 'Charge' }],
    });
    await repository.claimTask({
      workerId: 'dashboard-test',
      leaseDurationMs: 30_000,
    });

    const all = await repository.listWorkflows();
    expect(all).toHaveLength(2);
    expect(all.find(({ workflow }) => workflow.id === pending.workflow.id)).toMatchObject({
      taskCount: 2,
      completedTaskCount: 0,
      activeTaskCount: 1,
      failedTaskCount: 0,
    });
    expect(all.find(({ workflow }) => workflow.id === running.workflow.id)).toMatchObject({
      workflow: { status: 'running' },
      taskCount: 2,
      activeTaskCount: 1,
    });

    const runningOnly = await repository.listWorkflows({ status: 'running', limit: 10 });
    expect(runningOnly).toHaveLength(1);
    expect(runningOnly[0]?.workflow.id).toBe(running.workflow.id);
  });

  it('rejects invalid transitions without changing state or appending an event', async () => {
    const created = await repository.createWorkflow({
      name: 'Transition test',
      steps: [{ name: 'Only step' }],
    });

    await expect(
      repository.transitionWorkflow(created.workflow.id, 'completed'),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const unchanged = await repository.getWorkflow(created.workflow.id);
    expect(unchanged?.workflow.status).toBe('pending');
    expect(unchanged?.workflow.version).toBe(1);
    expect(unchanged?.events).toHaveLength(2);
  });

  it('records an accepted transition in the same transaction', async () => {
    const created = await repository.createWorkflow({
      name: 'Transition test',
      steps: [{ name: 'Only step' }],
    });

    const running = await repository.transitionWorkflow(created.workflow.id, 'running');

    expect(running?.workflow.status).toBe('running');
    expect(running?.workflow.version).toBe(2);
    expect(running?.workflow.startedAt).toBeInstanceOf(Date);
    expect(running?.events.at(-1)).toMatchObject({
      sequence: 3,
      eventType: 'workflow.status_changed',
      data: { from: 'pending', to: 'running' },
    });
  });

  it('serializes competing workflow transitions', async () => {
    const created = await repository.createWorkflow({
      name: 'Concurrent transition test',
      steps: [{ name: 'Only step' }],
    });

    const results = await Promise.allSettled([
      repository.transitionWorkflow(created.workflow.id, 'running'),
      repository.transitionWorkflow(created.workflow.id, 'running'),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.workflow).toMatchObject({ status: 'running', version: 2 });
    expect(
      reloaded?.events.filter(({ eventType }) => eventType === 'workflow.status_changed'),
    ).toHaveLength(1);
  });

  it('rolls back all rows when a later task cannot be serialized', async () => {
    const invalidPayload = { unsupported: BigInt(1) } as unknown as JsonObject;

    await expect(
      repository.createWorkflow({
        name: 'Rollback test',
        steps: [{ name: 'Valid first step' }, { name: 'Broken step', payload: invalidPayload }],
      }),
    ).rejects.toThrow();

    const counts = await pool.query<{ count: string }>(
      'SELECT count(*) FROM workflows WHERE name = $1',
      ['Rollback test'],
    );
    expect(Number(counts.rows[0]?.count)).toBe(0);
  });

  it('allows only one worker to claim a ready task', async () => {
    const created = await repository.createWorkflow({
      name: 'Atomic claim test',
      steps: [{ name: 'Claim me' }],
    });

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.claimTask({
          workerId: `worker-${index + 1}`,
          leaseDurationMs: 30_000,
        }),
      ),
    );
    const successfulClaims = claims.filter((claim) => claim !== null);

    expect(successfulClaims).toHaveLength(1);
    expect(successfulClaims[0]).toMatchObject({
      workflowId: created.workflow.id,
      status: 'leased',
      generation: 1,
      attemptCount: 1,
    });

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.workflow).toMatchObject({ status: 'running', version: 2 });
    expect(reloaded?.events.map(({ eventType }) => eventType)).toContain('task.leased');
  });

  it('renews only the current unexpired lease identity', async () => {
    const created = await repository.createWorkflow({
      name: 'Heartbeat test',
      steps: [{ name: 'Long task' }],
    });
    const claimed = await repository.claimTask({
      workerId: 'worker-a',
      leaseDurationMs: 1_000,
    });
    expect(claimed).not.toBeNull();

    const renewed = await repository.renewLease({
      taskId: claimed!.id,
      workerId: 'worker-a',
      generation: claimed!.generation,
      leaseDurationMs: 30_000,
    });

    expect(renewed?.leaseExpiresAt?.getTime()).toBeGreaterThan(claimed!.leaseExpiresAt!.getTime());
    await expect(
      repository.renewLease({
        taskId: claimed!.id,
        workerId: 'worker-b',
        generation: claimed!.generation,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.renewLease({
        taskId: claimed!.id,
        workerId: 'worker-a',
        generation: claimed!.generation + 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toBeNull();

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.events.at(-1)?.eventType).toBe('task.lease_renewed');
  });

  it('rejects an expired worker before another generation is claimed', async () => {
    const created = await repository.createWorkflow({
      name: 'Expired lease test',
      steps: [{ name: 'Expire me' }],
    });
    const claimed = await repository.claimTask({
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
    });
    expect(claimed).not.toBeNull();

    await pool.query(
      "UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [claimed!.id],
    );

    await expect(
      repository.completeTask({
        taskId: claimed!.id,
        workerId: 'worker-a',
        generation: claimed!.generation,
        result: { outcome: 'too late' },
      }),
    ).resolves.toBeNull();

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.tasks[0]?.status).toBe('leased');
    expect(reloaded?.events.some(({ eventType }) => eventType === 'task.completed')).toBe(false);
  });

  it('fences a stale worker after an expired task is reclaimed', async () => {
    const created = await repository.createWorkflow({
      name: 'Generation fencing test',
      steps: [{ name: 'Fence me' }],
    });
    const workerA = await repository.claimTask({
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
    });
    expect(workerA).not.toBeNull();

    await pool.query(
      "UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [workerA!.id],
    );

    const workerB = await repository.claimTask({
      workerId: 'worker-b',
      leaseDurationMs: 30_000,
    });
    expect(workerB).toMatchObject({
      id: workerA!.id,
      leaseOwner: 'worker-b',
      generation: 2,
      attemptCount: 2,
    });

    await expect(
      repository.completeTask({
        taskId: workerA!.id,
        workerId: 'worker-a',
        generation: workerA!.generation,
        result: { outcome: 'stale' },
      }),
    ).resolves.toBeNull();

    const completed = await repository.completeTask({
      taskId: workerB!.id,
      workerId: 'worker-b',
      generation: workerB!.generation,
      result: { outcome: 'accepted' },
    });
    expect(completed).toMatchObject({
      status: 'completed',
      result: { outcome: 'accepted' },
      generation: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.events.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining(['task.leased', 'task.reclaimed', 'task.completed']),
    );
    expect(reloaded?.events.filter(({ eventType }) => eventType === 'task.completed')).toHaveLength(
      1,
    );
  });

  it('applies failure through the same lease fence', async () => {
    const created = await repository.createWorkflow({
      name: 'Fenced failure test',
      steps: [{ name: 'Fail me' }],
    });
    const claimed = await repository.claimTask({
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
    });
    expect(claimed).not.toBeNull();

    const failed = await repository.failTask({
      taskId: claimed!.id,
      workerId: 'worker-a',
      generation: claimed!.generation,
      error: { code: 'DEMO_FAILURE', retryable: false },
      retryable: false,
      retryDelayMs: 1_000,
    });

    expect(failed).toMatchObject({
      status: 'failed',
      result: {
        error: { code: 'DEMO_FAILURE', retryable: false },
      },
    });
    await expect(
      repository.completeTask({
        taskId: claimed!.id,
        workerId: 'worker-a',
        generation: claimed!.generation,
        result: { outcome: 'late completion' },
      }),
    ).resolves.toBeNull();

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.workflow.status).toBe('failed');
    expect(reloaded?.events.some(({ eventType }) => eventType === 'task.failed')).toBe(true);
  });

  it('schedules exponential retries until the attempt ceiling', async () => {
    const created = await repository.createWorkflow({
      name: 'Retry test',
      steps: [{ name: 'Flaky step', maxAttempts: 2 }],
    });
    const first = await repository.claimTask({
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
    });

    const scheduled = await repository.failTask({
      taskId: first!.id,
      workerId: 'worker-a',
      generation: first!.generation,
      error: { code: 'TIMEOUT' },
      retryable: true,
      retryDelayMs: 60_000,
    });
    expect(scheduled).toMatchObject({
      status: 'retry_scheduled',
      attemptCount: 1,
      leaseOwner: null,
    });
    expect(scheduled?.nextAttemptAt).toBeInstanceOf(Date);
    await expect(
      repository.claimTask({ workerId: 'too-early', leaseDurationMs: 30_000 }),
    ).resolves.toBeNull();

    await pool.query(
      "UPDATE tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [first!.id],
    );
    const second = await repository.claimTask({
      workerId: 'worker-b',
      leaseDurationMs: 30_000,
    });
    expect(second).toMatchObject({ generation: 2, attemptCount: 2, status: 'leased' });

    const exhausted = await repository.failTask({
      taskId: second!.id,
      workerId: 'worker-b',
      generation: second!.generation,
      error: { code: 'TIMEOUT' },
      retryable: true,
      retryDelayMs: 120_000,
    });
    expect(exhausted).toMatchObject({ status: 'failed', attemptCount: 2 });

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.workflow.status).toBe('failed');
    expect(reloaded?.events.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining(['task.retry_scheduled', 'task.retried', 'task.failed']),
    );
  });

  it('compensates completed steps in reverse order after a forward failure', async () => {
    const created = await repository.createWorkflow({
      name: 'Compensated order',
      steps: [
        { name: 'Validate order', handler: 'validate-order' },
        {
          name: 'Charge payment',
          handler: 'charge-payment',
          compensationHandler: 'refund-payment',
        },
        {
          name: 'Reserve inventory',
          handler: 'reserve-inventory',
          compensationHandler: 'release-inventory',
        },
        { name: 'Send confirmation', handler: 'send-confirmation' },
      ],
    });

    for (let stepNumber = 1; stepNumber <= 3; stepNumber += 1) {
      const task = await repository.claimTask({
        workerId: `forward-${stepNumber}`,
        leaseDurationMs: 30_000,
      });
      expect(task?.stepNumber).toBe(stepNumber);
      await repository.completeTask({
        taskId: task!.id,
        workerId: `forward-${stepNumber}`,
        generation: task!.generation,
        result: { stepNumber },
      });
    }

    const confirmation = await repository.claimTask({
      workerId: 'forward-4',
      leaseDurationMs: 30_000,
    });
    await repository.failTask({
      taskId: confirmation!.id,
      workerId: 'forward-4',
      generation: confirmation!.generation,
      error: { code: 'EMAIL_REJECTED' },
      retryable: false,
      retryDelayMs: 0,
    });

    const inventory = await repository.claimTask({
      workerId: 'compensator-1',
      leaseDurationMs: 30_000,
    });
    expect(inventory).toMatchObject({
      stepNumber: 3,
      compensationHandler: 'release-inventory',
      executionMode: 'compensation',
      status: 'leased',
      attemptCount: 1,
    });
    await repository.completeTask({
      taskId: inventory!.id,
      workerId: 'compensator-1',
      generation: inventory!.generation,
      result: { releaseId: 'release-order-42' },
    });

    const payment = await repository.claimTask({
      workerId: 'compensator-2',
      leaseDurationMs: 30_000,
    });
    expect(payment).toMatchObject({
      stepNumber: 2,
      compensationHandler: 'refund-payment',
      executionMode: 'compensation',
      status: 'leased',
      attemptCount: 1,
    });
    await repository.completeTask({
      taskId: payment!.id,
      workerId: 'compensator-2',
      generation: payment!.generation,
      result: { refundId: 'refund-order-42' },
    });

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.workflow.status).toBe('compensated');
    expect(reloaded?.tasks.map(({ status }) => status)).toEqual([
      'completed',
      'compensated',
      'compensated',
      'failed',
    ]);
    expect(
      reloaded?.events
        .filter(({ eventType }) => eventType === 'task.compensation_ready')
        .map(({ data }) => data.stepNumber),
    ).toEqual([3, 2]);
    expect(reloaded?.events.at(-1)).toMatchObject({
      eventType: 'workflow.status_changed',
      data: { from: 'compensating', to: 'compensated' },
    });
  });

  it('retries compensation and marks the workflow when compensation is exhausted', async () => {
    const created = await repository.createWorkflow({
      name: 'Failed compensation',
      steps: [
        {
          name: 'Charge payment',
          handler: 'charge-payment',
          compensationHandler: 'refund-payment',
          maxAttempts: 2,
        },
        { name: 'Send confirmation', handler: 'send-confirmation' },
      ],
    });
    const payment = await repository.claimTask({
      workerId: 'forward-1',
      leaseDurationMs: 30_000,
    });
    await repository.completeTask({
      taskId: payment!.id,
      workerId: 'forward-1',
      generation: payment!.generation,
      result: { chargeId: 'charge-order-42' },
    });
    const confirmation = await repository.claimTask({
      workerId: 'forward-2',
      leaseDurationMs: 30_000,
    });
    await repository.failTask({
      taskId: confirmation!.id,
      workerId: 'forward-2',
      generation: confirmation!.generation,
      error: { code: 'EMAIL_REJECTED' },
      retryable: false,
      retryDelayMs: 0,
    });

    const firstRefund = await repository.claimTask({
      workerId: 'compensator-1',
      leaseDurationMs: 30_000,
    });
    const retry = await repository.failTask({
      taskId: firstRefund!.id,
      workerId: 'compensator-1',
      generation: firstRefund!.generation,
      error: { code: 'PAYMENT_TIMEOUT' },
      retryable: true,
      retryDelayMs: 60_000,
    });
    expect(retry).toMatchObject({
      status: 'retry_scheduled',
      executionMode: 'compensation',
      attemptCount: 1,
    });

    await pool.query(
      "UPDATE tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [firstRefund!.id],
    );
    const secondRefund = await repository.claimTask({
      workerId: 'compensator-2',
      leaseDurationMs: 30_000,
    });
    expect(secondRefund).toMatchObject({
      id: firstRefund!.id,
      executionMode: 'compensation',
      generation: 2,
      attemptCount: 2,
    });
    const exhausted = await repository.failTask({
      taskId: secondRefund!.id,
      workerId: 'compensator-2',
      generation: secondRefund!.generation,
      error: { code: 'PAYMENT_TIMEOUT' },
      retryable: true,
      retryDelayMs: 120_000,
    });
    expect(exhausted?.status).toBe('compensation_failed');

    const reloaded = await repository.getWorkflow(created.workflow.id);
    expect(reloaded?.workflow.status).toBe('compensation_failed');
    expect(reloaded?.events.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining([
        'task.compensation_leased',
        'task.retry_scheduled',
        'task.compensation_retried',
        'task.compensation_failed',
      ]),
    );
  });

  it('executes a concurrent idempotent effect only once', async () => {
    let executions = 0;
    const execute = () =>
      idempotency.execute({
        key: 'workflow-1:2:charge-payment',
        operation: 'charge-payment',
        request: { orderId: 'order-42', totalCents: 1299 },
        produce: async () => {
          executions += 1;
          return { chargeId: 'charge-order-42' };
        },
      });

    const outcomes = await Promise.all([execute(), execute()]);

    expect(executions).toBe(1);
    expect(outcomes.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(outcomes[0]?.response).toEqual(outcomes[1]?.response);
  });

  it('rejects an idempotency key reused with a different request', async () => {
    await idempotency.execute({
      key: 'workflow-1:2:charge-payment',
      operation: 'charge-payment',
      request: { totalCents: 1299 },
      produce: async () => ({ chargeId: 'charge-order-42' }),
    });

    await expect(
      idempotency.execute({
        key: 'workflow-1:2:charge-payment',
        operation: 'charge-payment',
        request: { totalCents: 9999 },
        produce: async () => ({ chargeId: 'should-not-run' }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
