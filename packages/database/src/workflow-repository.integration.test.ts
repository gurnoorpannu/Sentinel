import type { JsonObject } from '@sentinel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabasePool, type Pool } from './index.js';
import { runMigrations } from './migrations.js';
import { InvalidStateTransitionError, WorkflowRepository } from './workflow-repository.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase('WorkflowRepository with PostgreSQL', () => {
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
});
