import type { WorkflowDetail } from '@sentinel/contracts';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';

describe('API health endpoint', () => {
  it('reports a healthy database connection', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const app = buildApp({ database, workflows: createWorkflowStore(), logger: false });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      database: 'connected',
    });
    expect(database.query).toHaveBeenCalledWith('SELECT 1');
    await app.close();
  });

  it('returns 503 when PostgreSQL cannot be reached', async () => {
    const database = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const app = buildApp({ database, workflows: createWorkflowStore(), logger: false });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      database: 'disconnected',
    });
    await app.close();
  });
});

describe('workflow endpoints', () => {
  it('creates an ordered workflow and returns its location', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/workflows',
      payload: {
        name: 'Order fulfillment',
        payload: { orderId: 'order-42' },
        steps: [{ name: 'Validate order' }, { name: 'Charge payment', maxAttempts: 3 }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/workflows/${detail.workflow.id}`);
    expect(response.json()).toMatchObject({
      workflow: {
        id: detail.workflow.id,
        name: 'Order fulfillment',
      },
      tasks: [{ stepNumber: 1 }, { stepNumber: 2 }],
    });
    expect(workflows.createWorkflow).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects an invalid workflow definition', async () => {
    const workflows = createWorkflowStore();
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/workflows',
      payload: { name: '', steps: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_WORKFLOW' },
    });
    expect(workflows.createWorkflow).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates the four-step e-commerce workflow', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/workflows/ecommerce',
      payload: {
        orderId: 'order-42',
        customerEmail: 'buyer@example.com',
        totalCents: 1299,
        currency: 'usd',
        items: [{ sku: 'sentinel-shirt', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(workflows.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Order order-42',
        payload: expect.objectContaining({ currency: 'USD' }),
        steps: [
          expect.objectContaining({ handler: 'validate-order' }),
          expect.objectContaining({
            handler: 'charge-payment',
            compensationHandler: 'refund-payment',
          }),
          expect.objectContaining({
            handler: 'reserve-inventory',
            compensationHandler: 'release-inventory',
          }),
          expect.objectContaining({ handler: 'send-confirmation' }),
        ],
      }),
    );
    await app.close();
  });

  it('returns a workflow with ordered tasks and events', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows,
      logger: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/workflows/${detail.workflow.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workflow: { id: detail.workflow.id, status: 'pending' },
      events: [{ sequence: 1, eventType: 'workflow.created' }],
    });
    await app.close();
  });

  it('lists workflow summaries for the operations dashboard', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    workflows.listWorkflows.mockResolvedValue([
      {
        workflow: detail.workflow,
        taskCount: 2,
        completedTaskCount: 0,
        activeTaskCount: 1,
        failedTaskCount: 0,
      },
    ]);
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows,
      logger: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/workflows?status=pending&limit=20',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workflows: [
        {
          workflow: { id: detail.workflow.id, status: 'pending' },
          taskCount: 2,
          activeTaskCount: 1,
        },
      ],
    });
    expect(workflows.listWorkflows).toHaveBeenCalledWith({ status: 'pending', limit: 20 });
    await app.close();
  });

  it('returns 404 for a missing workflow', async () => {
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows: createWorkflowStore(),
      logger: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/workflows/00000000-0000-4000-8000-000000000099',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'WORKFLOW_NOT_FOUND',
        message: 'Workflow not found',
      },
    });
    await app.close();
  });

  it('returns the event-history integrity report for a workflow', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    workflows.verifyWorkflowHistory.mockResolvedValue({
      workflowId: detail.workflow.id,
      valid: true,
      eventCount: 1,
      latestSequence: 1,
      replayedWorkflowStatus: 'pending',
      replayedTaskStatuses: detail.tasks.map(({ id, status }) => ({ taskId: id, status })),
      issues: [],
    });
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows,
      logger: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/workflows/${detail.workflow.id}/history-integrity`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workflowId: detail.workflow.id,
      valid: true,
      latestSequence: 1,
      issues: [],
    });
    await app.close();
  });
});

function createWorkflowStore(detail: WorkflowDetail | null = null) {
  return {
    createWorkflow: vi.fn().mockResolvedValue(detail ?? createWorkflowDetail()),
    getWorkflow: vi.fn().mockResolvedValue(detail),
    listWorkflows: vi.fn().mockResolvedValue([]),
    verifyWorkflowHistory: vi.fn().mockResolvedValue(null),
  };
}

function createWorkflowDetail(): WorkflowDetail {
  const createdAt = new Date('2026-07-30T00:00:00.000Z');
  const workflowId = '00000000-0000-4000-8000-000000000001';

  return {
    workflow: {
      id: workflowId,
      name: 'Order fulfillment',
      status: 'pending',
      payload: { orderId: 'order-42' },
      version: 1,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
    },
    tasks: [
      {
        id: '00000000-0000-4000-8000-000000000011',
        workflowId,
        stepNumber: 1,
        name: 'Validate order',
        handler: 'validate-order',
        compensationHandler: null,
        executionMode: 'forward',
        status: 'ready',
        payload: {},
        result: null,
        maxAttempts: 5,
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        generation: 0,
        nextAttemptAt: null,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000012',
        workflowId,
        stepNumber: 2,
        name: 'Charge payment',
        handler: 'charge-payment',
        compensationHandler: 'refund-payment',
        executionMode: 'forward',
        status: 'blocked',
        payload: {},
        result: null,
        maxAttempts: 3,
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        generation: 0,
        nextAttemptAt: null,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      },
    ],
    events: [
      {
        id: '1',
        workflowId,
        taskId: null,
        sequence: 1,
        eventType: 'workflow.created',
        data: { name: 'Order fulfillment', stepCount: 2 },
        occurredAt: createdAt,
      },
    ],
  };
}
