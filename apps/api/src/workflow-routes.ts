import type { CreateWorkflowInput, WorkflowDetail } from '@sentinel/contracts';
import { InvalidWorkflowDefinitionError, type WorkflowRepository } from '@sentinel/database';
import type { FastifyInstance } from 'fastify';
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

export function registerWorkflowRoutes(app: FastifyInstance, workflows: WorkflowStore): void {
  app.post('/workflows', async (request, reply) => {
    try {
      const input = createWorkflowSchema.parse(request.body) as CreateWorkflowInput;
      const detail = await workflows.createWorkflow(input);
      return reply
        .status(201)
        .header('location', `/workflows/${detail.workflow.id}`)
        .send(serializeWorkflowDetail(detail));
    } catch (error) {
      if (error instanceof ZodError || error instanceof InvalidWorkflowDefinitionError) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_WORKFLOW',
            message: error.message,
            details: error instanceof ZodError ? error.issues : undefined,
          },
        });
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
