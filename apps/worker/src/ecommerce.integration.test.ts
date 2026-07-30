import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDatabasePool,
  runMigrations,
  WorkflowRepository,
  type Pool,
} from '@sentinel/database';

import { createDefaultHandlerRegistry } from './ecommerce-handlers.js';
import { executeLeasedTask } from './lease-executor.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase('e-commerce workflow with PostgreSQL', () => {
  let pool: Pool;
  let repository: WorkflowRepository;

  beforeAll(async () => {
    if (!testDatabaseUrl) {
      throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
    }
    await runMigrations({ connectionString: testDatabaseUrl });
    pool = createDatabasePool(testDatabaseUrl);
    repository = new WorkflowRepository(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE workflow_events, tasks, workflows RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('runs all four handlers strictly in order and completes the workflow', async () => {
    const payload = {
      orderId: 'order-42',
      customerEmail: 'buyer@example.com',
      totalCents: 1299,
      currency: 'USD',
      items: [{ sku: 'sentinel-shirt', quantity: 1 }],
    };
    const created = await repository.createWorkflow({
      name: 'Order order-42',
      payload,
      steps: [
        { name: 'Validate order', handler: 'validate-order', payload },
        { name: 'Charge payment', handler: 'charge-payment', payload },
        { name: 'Reserve inventory', handler: 'reserve-inventory', payload },
        { name: 'Send confirmation', handler: 'send-confirmation', payload },
      ],
    });
    const registry = createDefaultHandlerRegistry();
    const expectedHandlers = [
      'validate-order',
      'charge-payment',
      'reserve-inventory',
      'send-confirmation',
    ];

    for (const [index, expectedHandler] of expectedHandlers.entries()) {
      const task = await repository.claimTask({
        workerId: `worker-${index + 1}`,
        leaseDurationMs: 30_000,
      });
      expect(task).toMatchObject({
        workflowId: created.workflow.id,
        stepNumber: index + 1,
        handler: expectedHandler,
      });

      await expect(
        repository.claimTask({
          workerId: 'competing-worker',
          leaseDurationMs: 30_000,
        }),
      ).resolves.toBeNull();

      const outcome = await executeLeasedTask({
        repository,
        task: task!,
        workerId: `worker-${index + 1}`,
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        execute: async (leasedTask) => await registry.execute(leasedTask),
      });
      expect(outcome).toBe('completed');
    }

    const completed = await repository.getWorkflow(created.workflow.id);
    expect(completed?.workflow).toMatchObject({
      status: 'completed',
      version: 3,
    });
    expect(completed?.workflow.completedAt).toBeInstanceOf(Date);
    expect(completed?.tasks.map(({ status }) => status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(completed?.tasks.map(({ result }) => result)).toEqual([
      expect.objectContaining({ valid: true }),
      expect.objectContaining({ chargeId: 'charge-order-42' }),
      expect.objectContaining({ reservationId: 'reservation-order-42' }),
      expect.objectContaining({ confirmationId: 'confirmation-order-42' }),
    ]);
    expect(completed?.events.filter(({ eventType }) => eventType === 'task.ready')).toHaveLength(3);
    expect(completed?.events.at(-1)).toMatchObject({
      eventType: 'workflow.status_changed',
      data: { from: 'running', to: 'completed' },
    });
  });
});
