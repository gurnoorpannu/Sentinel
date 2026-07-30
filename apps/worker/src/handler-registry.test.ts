import type { Task } from '@sentinel/contracts';
import { describe, expect, it } from 'vitest';

import { createDefaultHandlerRegistry } from './ecommerce-handlers.js';
import { HandlerRegistry, UnknownTaskHandlerError } from './handler-registry.js';

describe('task handler registry', () => {
  it('dispatches every e-commerce handler by persisted name', async () => {
    const registry = createDefaultHandlerRegistry();
    const task = createTask();

    await expect(registry.execute({ ...task, handler: 'validate-order' })).resolves.toMatchObject({
      valid: true,
      orderId: 'order-42',
    });
    await expect(registry.execute({ ...task, handler: 'charge-payment' })).resolves.toMatchObject({
      chargeId: 'charge-order-42',
      amountCents: 1299,
    });
    await expect(
      registry.execute({ ...task, handler: 'reserve-inventory' }),
    ).resolves.toMatchObject({
      reservationId: 'reservation-order-42',
    });
    await expect(
      registry.execute({ ...task, handler: 'send-confirmation' }),
    ).resolves.toMatchObject({
      confirmationId: 'confirmation-order-42',
      recipient: 'buyer@example.com',
    });
  });

  it('rejects unknown persisted handlers', async () => {
    const registry = new HandlerRegistry();

    await expect(registry.execute({ ...createTask(), handler: 'missing' })).rejects.toBeInstanceOf(
      UnknownTaskHandlerError,
    );
  });
});

function createTask(): Task {
  const now = new Date('2026-07-30T00:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workflowId: '00000000-0000-4000-8000-000000000010',
    stepNumber: 1,
    name: 'Order task',
    handler: 'noop',
    compensationHandler: null,
    executionMode: 'forward',
    status: 'leased',
    payload: {
      orderId: 'order-42',
      customerEmail: 'buyer@example.com',
      totalCents: 1299,
      currency: 'USD',
      items: [{ sku: 'sentinel-shirt', quantity: 1 }],
    },
    result: null,
    maxAttempts: 5,
    attemptCount: 1,
    leaseOwner: 'worker-a',
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    generation: 1,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
