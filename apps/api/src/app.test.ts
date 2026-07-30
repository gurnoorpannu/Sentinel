import type { WorkflowDetail } from '@sentinel/contracts';
import { InvalidOperatorActionError, WorkflowVersionConflictError } from '@sentinel/database';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';

describe('API health endpoint', () => {
  it('reports process liveness without depending on PostgreSQL', async () => {
    const database = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const app = buildApp({ database, workflows: createWorkflowStore(), logger: false });

    const response = await app.inject({ method: 'GET', url: '/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    expect(database.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('reports readiness only when PostgreSQL and the required schema are available', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ schema_ready: true }] }) };
    const app = buildApp({ database, workflows: createWorkflowStore(), logger: false });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      database: 'connected',
      schema: 'current',
    });
    await app.close();
  });

  it('removes a shutting-down instance from readiness', async () => {
    const database = { query: vi.fn() };
    const app = buildApp({
      database,
      workflows: createWorkflowStore(),
      logger: false,
      isShuttingDown: () => true,
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      reason: 'shutting_down',
    });
    expect(database.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects readiness when migrations are missing', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ schema_ready: false }] }) };
    const app = buildApp({ database, workflows: createWorkflowStore(), logger: false });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      database: 'connected',
      schema: 'outdated',
    });
    await app.close();
  });

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

  it('exposes operational metrics only with the configured bearer token', async () => {
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            workflows_total: '3',
            workflows_pending: '1',
            workflows_running: '1',
            workflows_compensating: '0',
            workflows_completed: '1',
            workflows_failed: '0',
            workflows_compensated: '0',
            workflows_compensation_failed: '0',
            workflows_canceled: '0',
            tasks_ready: '1',
            tasks_leased: '1',
            tasks_retry_scheduled: '0',
            tasks_compensating: '0',
            tasks_expired_leases: '0',
            workflow_events_total: '12',
            idempotency_records_total: '2',
          },
        ],
      }),
    };
    const app = buildApp({
      database,
      workflows: createWorkflowStore(),
      logger: false,
      metricsToken: 'test-metrics-token',
    });

    await app.inject({ method: 'GET', url: '/live' });
    const unauthorized = await app.inject({ method: 'GET', url: '/metrics' });
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer test-metrics-token' },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain(
      'sentinel_api_requests_total{method="GET",route="/live",status="200"} 1',
    );
    expect(response.body).toContain('sentinel_workflows{status="running"} 1');
    expect(response.body).toContain('sentinel_workflow_events_total 12');
    await app.close();
  });

  it('does not register the metrics route without a token', async () => {
    const app = buildApp({
      database: { query: vi.fn() },
      workflows: createWorkflowStore(),
      logger: false,
    });

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(404);
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

  it('creates a typed failure-injected workflow only when chaos mode is enabled', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows,
      logger: false,
      chaosEnabled: true,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/workflows/ecommerce/chaos',
      payload: {
        orderId: 'order-chaos',
        customerEmail: 'buyer@example.com',
        totalCents: 4200,
        currency: 'USD',
        items: [{ sku: 'sentinel-shirt', quantity: 1 }],
        failure: {
          target: 'reserve-inventory',
          mode: 'retryable',
          attempts: 2,
          maxAttempts: 3,
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(workflows.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Chaos order order-chaos',
        payload: expect.objectContaining({
          chaosTarget: 'reserve-inventory',
          chaosMode: 'retryable',
        }),
        steps: expect.arrayContaining([
          expect.objectContaining({
            handler: 'reserve-inventory',
            payload: expect.objectContaining({
              sentinelFailure: {
                mode: 'retryable',
                attempts: 2,
                delayMs: 0,
              },
            }),
          }),
        ]),
      }),
    );
    await app.close();
  });

  it('does not expose the chaos workflow endpoint by default', async () => {
    const app = buildApp({
      database: { query: vi.fn().mockResolvedValue({}) },
      workflows: createWorkflowStore(),
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/workflows/ecommerce/chaos',
      payload: {},
    });

    expect(response.statusCode).toBe(404);
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

  it('does not register operator controls without an operator token', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    const app = buildApp({
      database: { query: vi.fn() },
      workflows,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/workflows/${detail.workflow.id}/operator-actions`,
      payload: {
        action: 'cancel',
        reason: 'Customer canceled the order',
        expectedVersion: 1,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(workflows.applyOperatorAction).not.toHaveBeenCalled();
    await app.close();
  });

  it('authenticates and validates operator actions before applying them', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    const app = buildApp({
      database: { query: vi.fn() },
      workflows,
      logger: false,
      operatorToken: 'sentinel-operator-token-with-32-chars',
    });
    const payload = {
      action: 'cancel',
      reason: 'Customer canceled the order',
      expectedVersion: 1,
    };

    const unauthorized = await app.inject({
      method: 'POST',
      url: `/workflows/${detail.workflow.id}/operator-actions`,
      headers: {
        authorization: 'Bearer wrong-token',
        'x-operator-id': 'operator@example.com',
      },
      payload,
    });
    const invalidIdentity = await app.inject({
      method: 'POST',
      url: `/workflows/${detail.workflow.id}/operator-actions`,
      headers: {
        authorization: 'Bearer sentinel-operator-token-with-32-chars',
        'x-operator-id': 'not a stable identity',
      },
      payload,
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/workflows/${detail.workflow.id}/operator-actions`,
      headers: {
        authorization: 'Bearer sentinel-operator-token-with-32-chars',
        'x-operator-id': 'operator@example.com',
      },
      payload,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(invalidIdentity.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(200);
    expect(workflows.applyOperatorAction).toHaveBeenCalledOnce();
    expect(workflows.applyOperatorAction).toHaveBeenCalledWith({
      workflowId: detail.workflow.id,
      actor: 'operator@example.com',
      ...payload,
    });
    await app.close();
  });

  it('returns actionable conflicts for stale or unsafe operator commands', async () => {
    const detail = createWorkflowDetail();
    const workflows = createWorkflowStore(detail);
    const app = buildApp({
      database: { query: vi.fn() },
      workflows,
      logger: false,
      operatorToken: 'sentinel-operator-token-with-32-chars',
    });
    const request = {
      method: 'POST' as const,
      url: `/workflows/${detail.workflow.id}/operator-actions`,
      headers: {
        authorization: 'Bearer sentinel-operator-token-with-32-chars',
        'x-operator-id': 'operator@example.com',
      },
      payload: {
        action: 'cancel',
        reason: 'Customer canceled the order',
        expectedVersion: 1,
      },
    };

    workflows.applyOperatorAction.mockRejectedValueOnce(new WorkflowVersionConflictError(1, 2));
    const stale = await app.inject(request);
    workflows.applyOperatorAction.mockRejectedValueOnce(
      new InvalidOperatorActionError('cancel', 'running', 'Only pending workflows can be canceled'),
    );
    const unsafe = await app.inject(request);

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: 'WORKFLOW_VERSION_CONFLICT',
        expectedVersion: 1,
        actualVersion: 2,
      },
    });
    expect(unsafe.statusCode).toBe(409);
    expect(unsafe.json()).toMatchObject({
      error: {
        code: 'OPERATOR_ACTION_CONFLICT',
        workflowStatus: 'running',
      },
    });
    await app.close();
  });
});

function createWorkflowStore(detail: WorkflowDetail | null = null) {
  return {
    createWorkflow: vi.fn().mockResolvedValue(detail ?? createWorkflowDetail()),
    applyOperatorAction: vi.fn().mockResolvedValue(detail),
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
