import {
  failureInjectionModes,
  workflowStatuses,
  type CreateWorkflowInput,
  type WorkflowDetail,
  type WorkflowSummary,
} from '@sentinel/contracts';
import { InvalidWorkflowDefinitionError, type WorkflowRepository } from '@sentinel/database';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';

export type WorkflowStore = Pick<
  WorkflowRepository,
  'createWorkflow' | 'getWorkflow' | 'listWorkflows' | 'verifyWorkflowHistory'
>;

const jsonObjectSchema = z.record(z.string(), z.json());

const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  payload: jsonObjectSchema.optional(),
  steps: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        handler: z
          .string()
          .regex(/^[a-z][a-z0-9._-]{0,119}$/)
          .optional(),
        compensationHandler: z
          .string()
          .regex(/^[a-z][a-z0-9._-]{0,119}$/)
          .optional(),
        payload: jsonObjectSchema.optional(),
        maxAttempts: z.number().int().min(1).max(100).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const workflowParametersSchema = z.object({
  workflowId: z.uuid(),
});

const listWorkflowsQuerySchema = z.object({
  status: z.enum(workflowStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ecommerceWorkflowSchema = z.object({
  orderId: z.string().trim().min(1).max(120),
  customerEmail: z.email(),
  totalCents: z.number().int().positive(),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  items: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(120),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100),
});

const chaosWorkflowSchema = ecommerceWorkflowSchema.extend({
  failure: z.object({
    target: z.enum(['charge-payment', 'reserve-inventory', 'send-confirmation']),
    mode: z.enum(failureInjectionModes),
    attempts: z.number().int().min(1).max(10).default(1),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    delayMs: z.number().int().min(0).max(300_000).optional(),
  }),
});

export function registerWorkflowRoutes(
  app: FastifyInstance,
  workflows: WorkflowStore,
  options: { chaosEnabled?: boolean; operatorToken?: string | undefined } = {},
): void {
  app.get('/workflows', async (request, reply) => {
    const query = listWorkflowsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_WORKFLOW_QUERY',
          message: 'Workflow filters are invalid',
          details: query.error.issues,
        },
      });
    }

    const summaries = await workflows.listWorkflows(query.data);
    return {
      workflows: summaries.map(serializeWorkflowSummary),
    };
  });

  app.post('/workflows/ecommerce', async (request, reply) => {
    try {
      const order = ecommerceWorkflowSchema.parse(request.body);
      const payload = {
        orderId: order.orderId,
        customerEmail: order.customerEmail,
        totalCents: order.totalCents,
        currency: order.currency,
        items: order.items,
      };
      const detail = await workflows.createWorkflow({
        name: `Order ${order.orderId}`,
        payload,
        steps: [
          { name: 'Validate order', handler: 'validate-order', payload },
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
            payload,
          },
          { name: 'Send confirmation', handler: 'send-confirmation', payload },
        ],
      });
      return sendCreatedWorkflow(reply, detail);
    } catch (error) {
      if (error instanceof ZodError || error instanceof InvalidWorkflowDefinitionError) {
        return sendInvalidWorkflow(reply, error);
      }
      throw error;
    }
  });

  if (options.chaosEnabled) {
    app.post('/workflows/ecommerce/chaos', async (request, reply) => {
      try {
        const input = chaosWorkflowSchema.parse(request.body);
        const payload = orderPayload(input);
        const failure = {
          mode: input.failure.mode,
          attempts: input.failure.attempts,
          delayMs: input.failure.delayMs ?? (input.failure.mode === 'hang' ? 45_000 : 0),
        };
        const withFailure = (handler: string) =>
          handler === input.failure.target ? { ...payload, sentinelFailure: failure } : payload;
        const detail = await workflows.createWorkflow({
          name: `Chaos order ${input.orderId}`,
          payload: { ...payload, chaosTarget: input.failure.target, chaosMode: input.failure.mode },
          steps: [
            { name: 'Validate order', handler: 'validate-order', payload },
            {
              name: 'Charge payment',
              handler: 'charge-payment',
              compensationHandler: 'refund-payment',
              payload: withFailure('charge-payment'),
              maxAttempts: input.failure.maxAttempts,
            },
            {
              name: 'Reserve inventory',
              handler: 'reserve-inventory',
              compensationHandler: 'release-inventory',
              payload: withFailure('reserve-inventory'),
              maxAttempts: input.failure.maxAttempts,
            },
            {
              name: 'Send confirmation',
              handler: 'send-confirmation',
              payload: withFailure('send-confirmation'),
              maxAttempts: input.failure.maxAttempts,
            },
          ],
        });
        return sendCreatedWorkflow(reply, detail);
      } catch (error) {
        if (error instanceof ZodError || error instanceof InvalidWorkflowDefinitionError) {
          return sendInvalidWorkflow(reply, error);
        }
        throw error;
      }
    });
  }

  app.post('/workflows', async (request, reply) => {
    try {
      const input = createWorkflowSchema.parse(request.body) as CreateWorkflowInput;
      const detail = await workflows.createWorkflow(input);
      return sendCreatedWorkflow(reply, detail);
    } catch (error) {
      if (error instanceof ZodError || error instanceof InvalidWorkflowDefinitionError) {
        return sendInvalidWorkflow(reply, error);
      }

      throw error;
    }
  });

  app.get('/workflows/:workflowId', async (request, reply) => {
    const parsedParameters = workflowParametersSchema.safeParse(request.params);
    if (!parsedParameters.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_WORKFLOW_ID',
          message: 'workflowId must be a UUID',
        },
      });
    }

    const detail = await workflows.getWorkflow(parsedParameters.data.workflowId);
    if (!detail) {
      return reply.status(404).send({
        error: {
          code: 'WORKFLOW_NOT_FOUND',
          message: 'Workflow not found',
        },
      });
    }

    return serializeWorkflowDetail(detail);
  });

  app.get('/workflows/:workflowId/history-integrity', async (request, reply) => {
    const parsedParameters = workflowParametersSchema.safeParse(request.params);
    if (!parsedParameters.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_WORKFLOW_ID',
          message: 'workflowId must be a UUID',
        },
      });
    }

    const report = await workflows.verifyWorkflowHistory(parsedParameters.data.workflowId);
    if (!report) {
      return reply.status(404).send({
        error: {
          code: 'WORKFLOW_NOT_FOUND',
          message: 'Workflow not found',
        },
      });
    }

    return report;
  });
}

function orderPayload(order: z.infer<typeof ecommerceWorkflowSchema>) {
  return {
    orderId: order.orderId,
    customerEmail: order.customerEmail,
    totalCents: order.totalCents,
    currency: order.currency,
    items: order.items,
  };
}

function sendCreatedWorkflow(reply: FastifyReply, detail: WorkflowDetail) {
  return reply
    .status(201)
    .header('location', `/workflows/${detail.workflow.id}`)
    .send(serializeWorkflowDetail(detail));
}

function sendInvalidWorkflow(
  reply: FastifyReply,
  error: ZodError | InvalidWorkflowDefinitionError,
) {
  return reply.status(400).send({
    error: {
      code: 'INVALID_WORKFLOW',
      message: error.message,
      details: error instanceof ZodError ? error.issues : undefined,
    },
  });
}

function serializeWorkflowDetail(detail: WorkflowDetail) {
  return {
    workflow: serializeDates(detail.workflow),
    tasks: detail.tasks.map(serializeDates),
    events: detail.events.map(serializeDates),
  };
}

function serializeWorkflowSummary(summary: WorkflowSummary) {
  return {
    ...summary,
    workflow: serializeDates(summary.workflow),
  };
}

function serializeDates<Value extends object>(value: Value): Value {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      item instanceof Date ? item.toISOString() : item,
    ]),
  ) as Value;
}
