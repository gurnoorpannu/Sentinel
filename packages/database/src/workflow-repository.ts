import {
  canTransitionWorkflow,
  type CreateWorkflowInput,
  type JsonObject,
  type JsonValue,
  type Task,
  type TaskStatus,
  type Workflow,
  type WorkflowDetail,
  type WorkflowEvent,
  type WorkflowStatus,
} from '@sentinel/contracts';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

interface WorkflowRow extends QueryResultRow {
  id: string;
  name: string;
  status: WorkflowStatus;
  payload: JsonObject;
  version: string;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface TaskRow extends QueryResultRow {
  id: string;
  workflow_id: string;
  step_number: number;
  name: string;
  status: TaskStatus;
  payload: JsonObject;
  result: JsonValue | null;
  max_attempts: number;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  generation: string;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface EventRow extends QueryResultRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  sequence: string;
  event_type: string;
  data: JsonObject;
  occurred_at: Date;
}

interface StatusRow extends QueryResultRow {
  status: WorkflowStatus;
}

export class InvalidWorkflowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkflowDefinitionError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: WorkflowStatus,
    public readonly to: WorkflowStatus,
  ) {
    super(`Workflow cannot transition from ${from} to ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class WorkflowRepository {
  constructor(private readonly pool: Pool) {}

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowDetail> {
    validateDefinition(input);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const workflowResult = await client.query<WorkflowRow>(
        `
          INSERT INTO workflows (name, payload)
          VALUES ($1, $2::jsonb)
          RETURNING
            id, name, status, payload, version, created_at, updated_at,
            started_at, completed_at
        `,
        [input.name.trim(), JSON.stringify(input.payload ?? {})],
      );
      const workflow = requireFirstRow(workflowResult.rows, 'Workflow insert returned no row');

      await appendEvent(client, {
        workflowId: workflow.id,
        eventType: 'workflow.created',
        data: {
          name: workflow.name,
          stepCount: input.steps.length,
        },
      });

      for (const [index, step] of input.steps.entries()) {
        const taskResult = await client.query<TaskRow>(
          `
            INSERT INTO tasks (
              workflow_id, step_number, name, status, payload, max_attempts
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            RETURNING
              id, workflow_id, step_number, name, status, payload, result,
              max_attempts, attempt_count, lease_owner, lease_expires_at,
              generation, next_attempt_at, created_at, updated_at, completed_at
          `,
          [
            workflow.id,
            index + 1,
            step.name.trim(),
            index === 0 ? 'ready' : 'blocked',
            JSON.stringify(step.payload ?? {}),
            step.maxAttempts ?? 5,
          ],
        );
        const task = requireFirstRow(taskResult.rows, 'Task insert returned no row');

        await appendEvent(client, {
          workflowId: workflow.id,
          taskId: task.id,
          eventType: 'task.created',
          data: {
            name: task.name,
            status: task.status,
            stepNumber: task.step_number,
          },
        });
      }

      const detail = await getWorkflowWithClient(client, workflow.id);
      if (!detail) {
        throw new Error('Created workflow could not be reloaded');
      }

      await client.query('COMMIT');
      return detail;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getWorkflow(workflowId: string): Promise<WorkflowDetail | null> {
    const client = await this.pool.connect();
    try {
      return await getWorkflowWithClient(client, workflowId);
    } finally {
      client.release();
    }
  }

  async transitionWorkflow(
    workflowId: string,
    to: WorkflowStatus,
  ): Promise<WorkflowDetail | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const currentResult = await client.query<StatusRow>(
        'SELECT status FROM workflows WHERE id = $1 FOR UPDATE',
        [workflowId],
      );
      const current = currentResult.rows[0];

      if (!current) {
        await client.query('ROLLBACK');
        return null;
      }

      if (!canTransitionWorkflow(current.status, to)) {
        throw new InvalidStateTransitionError(current.status, to);
      }

      await client.query(
        `
          UPDATE workflows
          SET
            status = $2,
            version = version + 1,
            updated_at = now(),
            started_at = CASE
              WHEN $2 = 'running' AND started_at IS NULL THEN now()
              ELSE started_at
            END,
            completed_at = CASE
              WHEN $2 IN ('completed', 'failed', 'compensated', 'compensation_failed')
                THEN now()
              ELSE completed_at
            END
          WHERE id = $1
        `,
        [workflowId, to],
      );

      await appendEvent(client, {
        workflowId,
        eventType: 'workflow.status_changed',
        data: { from: current.status, to },
      });

      const detail = await getWorkflowWithClient(client, workflowId);
      await client.query('COMMIT');
      return detail;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function validateDefinition(input: CreateWorkflowInput): void {
  const workflowName = input.name.trim();
  if (workflowName.length === 0 || workflowName.length > 120) {
    throw new InvalidWorkflowDefinitionError('Workflow name must contain 1 to 120 characters');
  }

  if (input.steps.length === 0 || input.steps.length > 50) {
    throw new InvalidWorkflowDefinitionError('Workflow must contain 1 to 50 steps');
  }

  for (const [index, step] of input.steps.entries()) {
    const stepName = step.name.trim();
    if (stepName.length === 0 || stepName.length > 120) {
      throw new InvalidWorkflowDefinitionError(
        `Step ${index + 1} name must contain 1 to 120 characters`,
      );
    }

    const maxAttempts = step.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new InvalidWorkflowDefinitionError(
        `Step ${index + 1} maxAttempts must be an integer between 1 and 100`,
      );
    }
  }
}

interface AppendEventInput {
  workflowId: string;
  taskId?: string;
  eventType: string;
  data: JsonObject;
}

async function appendEvent(client: PoolClient, input: AppendEventInput): Promise<void> {
  const sequenceResult = await client.query<{ event_sequence: string }>(
    `
      UPDATE workflows
      SET event_sequence = event_sequence + 1
      WHERE id = $1
      RETURNING event_sequence
    `,
    [input.workflowId],
  );
  const sequence = requireFirstRow(
    sequenceResult.rows,
    'Cannot append an event to a missing workflow',
  ).event_sequence;

  await client.query(
    `
      INSERT INTO workflow_events (
        workflow_id, task_id, sequence, event_type, data
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [
      input.workflowId,
      input.taskId ?? null,
      sequence,
      input.eventType,
      JSON.stringify(input.data),
    ],
  );
}

async function getWorkflowWithClient(
  client: PoolClient,
  workflowId: string,
): Promise<WorkflowDetail | null> {
  const workflowResult = await client.query<WorkflowRow>(
    `
      SELECT
        id, name, status, payload, version, created_at, updated_at,
        started_at, completed_at
      FROM workflows
      WHERE id = $1
    `,
    [workflowId],
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) {
    return null;
  }

  const [taskResult, eventResult] = await Promise.all([
    client.query<TaskRow>(
      `
        SELECT
          id, workflow_id, step_number, name, status, payload, result,
          max_attempts, attempt_count, lease_owner, lease_expires_at,
          generation, next_attempt_at, created_at, updated_at, completed_at
        FROM tasks
        WHERE workflow_id = $1
        ORDER BY step_number
      `,
      [workflowId],
    ),
    client.query<EventRow>(
      `
        SELECT
          id, workflow_id, task_id, sequence, event_type, data, occurred_at
        FROM workflow_events
        WHERE workflow_id = $1
        ORDER BY sequence
      `,
      [workflowId],
    ),
  ]);

  return {
    workflow: mapWorkflow(workflow),
    tasks: taskResult.rows.map(mapTask),
    events: eventResult.rows.map(mapEvent),
  };
}

function mapWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    payload: row.payload,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    stepNumber: row.step_number,
    name: row.name,
    status: row.status,
    payload: row.payload,
    result: row.result,
    maxAttempts: row.max_attempts,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    generation: Number(row.generation),
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapEvent(row: EventRow): WorkflowEvent {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    data: row.data,
    occurredAt: row.occurred_at,
  };
}

function requireFirstRow<Row>(rows: Row[], message: string): Row {
  const row = rows[0];
  if (!row) {
    throw new Error(message);
  }
  return row;
}
