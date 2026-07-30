import type { CreateWorkflowInput, WorkflowDetail } from '@sentinel/contracts';
import { InvalidWorkflowDefinitionError, type WorkflowRepository } from '@sentinel/database';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';

export type WorkflowStore = Pick<WorkflowRepository, 'createWorkflow' | 'getWorkflow'>;

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

export function registerWorkflowRoutes(app: FastifyInstance, workflows: WorkflowStore): void {
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

function serializeDates<Value extends object>(value: Value): Value {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      item instanceof Date ? item.toISOString() : item,
    ]),
  ) as Value;
}
