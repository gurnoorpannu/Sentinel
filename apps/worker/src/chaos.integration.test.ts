import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDatabasePool,
  IdempotencyRepository,
  runMigrations,
  WorkflowRepository,
  type Pool,
} from '@sentinel/database';

import { createDefaultHandlerRegistry } from './ecommerce-handlers.js';
import {
  disablesHeartbeat,
  executeWithFailureInjection,
  InjectedWorkerCrashError,
  readFailureInjection,
} from './failure-injection.js';
import { executeLeasedTask } from './lease-executor.js';
import { RetryableTaskError } from './retry-policy.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase('failure-injected recovery with PostgreSQL', () => {
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

  it('recovers a crash after payment without executing the effect twice', async () => {
    const payload = orderPayload({
      mode: 'crash_after_effect',
      attempts: 1,
    });
    const created = await repository.createWorkflow({
      name: 'Crash after payment',
      steps: [{ name: 'Charge payment', handler: 'charge-payment', payload }],
    });
    const registry = createDefaultHandlerRegistry(idempotency);
    const workerA = await repository.claimTask({
      workerId: 'crash-worker',
      leaseDurationMs: 30_000,
    });

    const abandoned = await executeLeasedTask({
      repository,
      task: workerA!,
      workerId: 'crash-worker',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      execute: async (task) =>
        await executeWithFailureInjection(task, async (injectedTask) => {
          return await registry.execute(injectedTask);
        }),
      isAbandoned: (error) => error instanceof InjectedWorkerCrashError,
    });
    expect(abandoned).toBe('abandoned');

    const afterCrash = await repository.getWorkflow(created.workflow.id);
    expect(afterCrash?.tasks[0]).toMatchObject({
      status: 'leased',
      generation: 1,
      attemptCount: 1,
    });
    await expireLease(pool, workerA!.id);

    const workerB = await repository.claimTask({
      workerId: 'recovery-worker',
      leaseDurationMs: 30_000,
    });
    const recovered = await executeChaosTask(repository, registry, workerB!, 'recovery-worker');
    expect(recovered).toBe('completed');

    const completed = await repository.getWorkflow(created.workflow.id);
    expect(completed?.workflow.status).toBe('completed');
    expect(completed?.tasks[0]).toMatchObject({
      status: 'completed',
      generation: 2,
      attemptCount: 2,
      result: { chargeId: 'charge-order-chaos' },
    });
    const effects = await pool.query<{ count: string }>(
      "SELECT count(*) FROM idempotency_records WHERE operation = 'charge-payment'",
    );
    expect(Number(effects.rows[0]?.count)).toBe(1);
    await expect(repository.verifyWorkflowHistory(created.workflow.id)).resolves.toMatchObject({
      valid: true,
    });
  });

  it('reclaims a heartbeat-free hang and fences the stale worker result', async () => {
    const created = await repository.createWorkflow({
      name: 'Hung worker recovery',
      steps: [
        {
          name: 'Hung step',
          handler: 'noop',
          payload: {
            sentinelFailure: {
              mode: 'hang',
              attempts: 1,
              delayMs: 100,
            },
          },
        },
      ],
    });
    const registry = createDefaultHandlerRegistry(idempotency);
    const workerA = await repository.claimTask({
      workerId: 'hung-worker',
      leaseDurationMs: 30_000,
    });
    let workerB: Awaited<ReturnType<WorkflowRepository['claimTask']>>;
    const plan = readFailureInjection(workerA!);

    const staleOutcome = await executeLeasedTask({
      repository,
      task: workerA!,
      workerId: 'hung-worker',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      heartbeatEnabled: !disablesHeartbeat(plan),
      execute: async (task) =>
        await executeWithFailureInjection(
          task,
          async (injectedTask) => await registry.execute(injectedTask),
          async () => {
            await expireLease(pool, task.id);
            workerB = await repository.claimTask({
              workerId: 'recovery-worker',
              leaseDurationMs: 30_000,
            });
          },
        ),
    });

    expect(staleOutcome).toBe('fenced');
    expect(workerB!).toMatchObject({
      id: workerA!.id,
      generation: 2,
      attemptCount: 2,
      leaseOwner: 'recovery-worker',
    });
    const recovered = await executeChaosTask(repository, registry, workerB!, 'recovery-worker');
    expect(recovered).toBe('completed');

    const completed = await repository.getWorkflow(created.workflow.id);
    expect(completed?.workflow.status).toBe('completed');
    expect(completed?.events.map(({ eventType }) => eventType)).toContain('task.reclaimed');
    await expect(repository.verifyWorkflowHistory(created.workflow.id)).resolves.toMatchObject({
      valid: true,
    });
  });

  it('exhausts injected retries and compensates a completed payment', async () => {
    const payload = orderPayload();
    const created = await repository.createWorkflow({
      name: 'Retry exhaustion compensation',
      steps: [
        {
          name: 'Charge payment',
          handler: 'charge-payment',
          compensationHandler: 'refund-payment',
          payload,
        },
        {
          name: 'Reserve inventory',
          handler: 'reserve-inventory',
          compensationHandler: 'release-inventory',
          payload: orderPayload({
            mode: 'retryable',
            attempts: 2,
          }),
          maxAttempts: 2,
        },
      ],
    });
    const registry = createDefaultHandlerRegistry(idempotency);
    const payment = await repository.claimTask({
      workerId: 'forward-payment',
      leaseDurationMs: 30_000,
    });
    await executeChaosTask(repository, registry, payment!, 'forward-payment');

    const firstInventory = await repository.claimTask({
      workerId: 'inventory-1',
      leaseDurationMs: 30_000,
    });
    expect(await executeChaosTask(repository, registry, firstInventory!, 'inventory-1')).toBe(
      'retry_scheduled',
    );
    await pool.query(
      "UPDATE tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [firstInventory!.id],
    );

    const secondInventory = await repository.claimTask({
      workerId: 'inventory-2',
      leaseDurationMs: 30_000,
    });
    expect(await executeChaosTask(repository, registry, secondInventory!, 'inventory-2')).toBe(
      'failed',
    );

    const refund = await repository.claimTask({
      workerId: 'compensator',
      leaseDurationMs: 30_000,
    });
    expect(refund).toMatchObject({
      stepNumber: 1,
      executionMode: 'compensation',
      compensationHandler: 'refund-payment',
    });
    expect(await executeChaosTask(repository, registry, refund!, 'compensator')).toBe('completed');

    const compensated = await repository.getWorkflow(created.workflow.id);
    expect(compensated?.workflow.status).toBe('compensated');
    expect(compensated?.tasks.map(({ status }) => status)).toEqual(['compensated', 'failed']);
    const effects = await pool.query<{ operation: string }>(
      `
        SELECT operation
        FROM idempotency_records
        ORDER BY operation
      `,
    );
    expect(effects.rows.map(({ operation }) => operation)).toEqual([
      'charge-payment',
      'refund-payment',
    ]);
    await expect(repository.verifyWorkflowHistory(created.workflow.id)).resolves.toMatchObject({
      valid: true,
    });
  });
});

async function executeChaosTask(
  repository: WorkflowRepository,
  registry: ReturnType<typeof createDefaultHandlerRegistry>,
  task: NonNullable<Awaited<ReturnType<WorkflowRepository['claimTask']>>>,
  workerId: string,
) {
  const plan = readFailureInjection(task);
  return await executeLeasedTask({
    repository,
    task,
    workerId,
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    heartbeatEnabled: !disablesHeartbeat(plan),
    execute: async (leasedTask) =>
      await executeWithFailureInjection(
        leasedTask,
        async (injectedTask) => await registry.execute(injectedTask),
      ),
    retryPolicy: {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    isRetryable: (error) => error instanceof RetryableTaskError,
    isAbandoned: (error) => error instanceof InjectedWorkerCrashError,
  });
}

async function expireLease(pool: Pool, taskId: string): Promise<void> {
  await pool.query(
    "UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [taskId],
  );
}

function orderPayload(
  sentinelFailure?: Record<string, string | number>,
): Record<
  string,
  string | number | Array<{ sku: string; quantity: number }> | Record<string, string | number>
> {
  return {
    orderId: 'order-chaos',
    customerEmail: 'buyer@example.com',
    totalCents: 4200,
    currency: 'USD',
    items: [{ sku: 'sentinel-shirt', quantity: 1 }],
    ...(sentinelFailure ? { sentinelFailure } : {}),
  };
}
