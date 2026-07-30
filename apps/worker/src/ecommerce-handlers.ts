import type { JsonObject, JsonValue, Task } from '@sentinel/contracts';

import { HandlerRegistry } from './handler-registry.js';

interface OrderItem {
  sku: string;
  quantity: number;
}

interface EcommerceOrder {
  orderId: string;
  customerEmail: string;
  totalCents: number;
  currency: string;
  items: OrderItem[];
}

export interface IdempotencyExecutor {
  execute(input: {
    key: string;
    operation: string;
    request: JsonObject;
    produce: () => Promise<JsonValue>;
  }): Promise<{ response: JsonValue; replayed: boolean }>;
}

export function createDefaultHandlerRegistry(
  idempotency: IdempotencyExecutor = new InMemoryIdempotencyExecutor(),
): HandlerRegistry {
  return new HandlerRegistry()
    .register('noop', async (task) => ({
      acknowledged: true,
      taskName: task.name,
    }))
    .register('validate-order', async (task) => {
      const order = parseOrder(task);
      return {
        valid: true,
        orderId: order.orderId,
        itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
      };
    })
    .register('charge-payment', async (task) => {
      const order = parseOrder(task);
      return await executeIdempotently(idempotency, task, 'charge-payment', async () => ({
        chargeId: `charge-${order.orderId}`,
        orderId: order.orderId,
        amountCents: order.totalCents,
        currency: order.currency,
      }));
    })
    .register('reserve-inventory', async (task) => {
      const order = parseOrder(task);
      return await executeIdempotently(idempotency, task, 'reserve-inventory', async () => ({
        reservationId: `reservation-${order.orderId}`,
        orderId: order.orderId,
        items: order.items.map((item) => ({
          sku: item.sku,
          quantity: item.quantity,
        })),
      }));
    })
    .register('send-confirmation', async (task) => {
      const order = parseOrder(task);
      return await executeIdempotently(idempotency, task, 'send-confirmation', async () => ({
        confirmationId: `confirmation-${order.orderId}`,
        orderId: order.orderId,
        recipient: order.customerEmail,
      }));
    });
}

class InMemoryIdempotencyExecutor implements IdempotencyExecutor {
  private readonly records = new Map<string, { request: string; response: JsonValue }>();

  async execute(input: {
    key: string;
    operation: string;
    request: JsonObject;
    produce: () => Promise<JsonValue>;
  }): Promise<{ response: JsonValue; replayed: boolean }> {
    const request = JSON.stringify(input.request);
    const existing = this.records.get(input.key);
    if (existing) {
      if (existing.request !== request) {
        throw new Error(`Idempotency key "${input.key}" request conflict`);
      }
      return { response: existing.response, replayed: true };
    }
    const response = await input.produce();
    this.records.set(input.key, { request, response });
    return { response, replayed: false };
  }
}

async function executeIdempotently(
  idempotency: IdempotencyExecutor,
  task: Task,
  operation: string,
  produce: () => Promise<JsonValue>,
): Promise<JsonValue> {
  const outcome = await idempotency.execute({
    key: `${task.workflowId}:${task.stepNumber}:${task.handler}`,
    operation,
    request: task.payload,
    produce,
  });
  return outcome.response;
}

function parseOrder(task: Task): EcommerceOrder {
  const orderId = requireString(task.payload, 'orderId');
  const customerEmail = requireString(task.payload, 'customerEmail');
  const totalCents = requirePositiveInteger(task.payload, 'totalCents');
  const currency = requireString(task.payload, 'currency');
  const itemsValue = task.payload.items;

  if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
    throw new TypeError('Task payload items must be a non-empty array');
  }

  const items = itemsValue.map((item, index) => {
    if (!isJsonObject(item)) {
      throw new TypeError(`Task payload item ${index + 1} must be an object`);
    }
    return {
      sku: requireString(item, 'sku'),
      quantity: requirePositiveInteger(item, 'quantity'),
    };
  });

  return {
    orderId,
    customerEmail,
    totalCents,
    currency,
    items,
  };
}

function requireString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Task payload ${key} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(payload: JsonObject, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`Task payload ${key} must be a positive integer`);
  }
  return value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
