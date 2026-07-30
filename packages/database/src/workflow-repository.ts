import {
  canTransitionWorkflow,
  type ClaimTaskInput,
  type CompleteTaskInput,
  type CreateWorkflowInput,
  type FailTaskInput,
  type JsonObject,
  type JsonValue,
  type RenewLeaseInput,
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
  handler: string;
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

interface CandidateTaskRow extends QueryResultRow {
  id: string;
  workflow_id: string;
  status: TaskStatus;
}

interface NextTaskRow extends QueryResultRow {
  id: string;
  status: TaskStatus;
  step_number: number;
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
              workflow_id, step_number, name, handler, status, payload, max_attempts
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            RETURNING
              id, workflow_id, step_number, name, handler, status, payload, result,
              max_attempts, attempt_count, lease_owner, lease_expires_at,
              generation, next_attempt_at, created_at, updated_at, completed_at
          `,
          [
            workflow.id,
            index + 1,
            step.name.trim(),
            step.handler ?? 'noop',
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

  async transitionWorkflow(workflowId: string, to: WorkflowStatus): Promise<WorkflowDetail | null> {
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

  async claimTask({ workerId, leaseDurationMs }: ClaimTaskInput): Promise<Task | null> {
    validateLeaseSettings(workerId, leaseDurationMs);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const candidateResult = await client.query<CandidateTaskRow>(
        `
          SELECT t.id, t.workflow_id, t.status
          FROM tasks t
          INNER JOIN workflows w ON w.id = t.workflow_id
          WHERE
            w.status IN ('pending', 'running')
            AND t.attempt_count < t.max_attempts
            AND (
              t.status = 'ready'
              OR (
                t.status = 'leased'
                AND t.lease_expires_at <= now()
              )
            )
          ORDER BY t.created_at, t.workflow_id, t.step_number
          FOR UPDATE OF t SKIP LOCKED
          LIMIT 1
        `,
      );
      const candidate = candidateResult.rows[0];

      if (!candidate) {
        await client.query('COMMIT');
        return null;
      }

      const workflowStarted = await client.query(
        `
          UPDATE workflows
          SET
            status = 'running',
            version = version + 1,
            updated_at = now(),
            started_at = COALESCE(started_at, now())
          WHERE id = $1 AND status = 'pending'
        `,
        [candidate.workflow_id],
      );

      if (workflowStarted.rowCount === 1) {
        await appendEvent(client, {
          workflowId: candidate.workflow_id,
          eventType: 'workflow.status_changed',
          data: { from: 'pending', to: 'running' },
        });
      }

      const taskResult = await client.query<TaskRow>(
        `
          UPDATE tasks
          SET
            status = 'leased',
            lease_owner = $2,
            lease_expires_at = now() + ($3 * interval '1 millisecond'),
            generation = generation + 1,
            attempt_count = attempt_count + 1,
            updated_at = now()
          WHERE id = $1
          RETURNING ${taskColumns}
        `,
        [candidate.id, workerId, leaseDurationMs],
      );
      const task = requireFirstRow(taskResult.rows, 'Claimed task could not be reloaded');

      await appendEvent(client, {
        workflowId: task.workflow_id,
        taskId: task.id,
        eventType: candidate.status === 'leased' ? 'task.reclaimed' : 'task.leased',
        data: {
          workerId,
          generation: Number(task.generation),
          leaseExpiresAt: task.lease_expires_at?.toISOString() ?? null,
        },
      });

      await client.query('COMMIT');
      return mapTask(task);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLease({
    taskId,
    workerId,
    generation,
    leaseDurationMs,
  }: RenewLeaseInput): Promise<Task | null> {
    validateLeaseSettings(workerId, leaseDurationMs);
    validateGeneration(generation);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const taskResult = await client.query<TaskRow>(
        `
          UPDATE tasks
          SET
            lease_expires_at = now() + ($4 * interval '1 millisecond'),
            updated_at = now()
          WHERE
            id = $1
            AND status = 'leased'
            AND lease_owner = $2
            AND generation = $3
            AND lease_expires_at > now()
          RETURNING ${taskColumns}
        `,
        [taskId, workerId, generation, leaseDurationMs],
      );
      const task = taskResult.rows[0];

      if (!task) {
        await client.query('COMMIT');
        return null;
      }

      await appendEvent(client, {
        workflowId: task.workflow_id,
        taskId: task.id,
        eventType: 'task.lease_renewed',
        data: {
          workerId,
          generation,
          leaseExpiresAt: task.lease_expires_at?.toISOString() ?? null,
        },
      });

      await client.query('COMMIT');
      return mapTask(task);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completeTask({
    taskId,
    workerId,
    generation,
    result,
  }: CompleteTaskInput): Promise<Task | null> {
    return await this.settleTask({
      taskId,
      workerId,
      generation,
      status: 'completed',
      result,
      eventType: 'task.completed',
    });
  }

  async failTask({ taskId, workerId, generation, error }: FailTaskInput): Promise<Task | null> {
    return await this.settleTask({
      taskId,
      workerId,
      generation,
      status: 'failed',
      result: { error },
      eventType: 'task.failed',
    });
  }

  private async settleTask(input: {
    taskId: string;
    workerId: string;
    generation: number;
    status: 'completed' | 'failed';
    result: JsonValue;
    eventType: 'task.completed' | 'task.failed';
  }): Promise<Task | null> {
    validateWorkerId(input.workerId);
    validateGeneration(input.generation);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const taskResult = await client.query<TaskRow>(
        `
          UPDATE tasks
          SET
            status = $4,
            result = $5::jsonb,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now(),
            completed_at = now()
          WHERE
            id = $1
            AND status = 'leased'
            AND lease_owner = $2
            AND generation = $3
            AND lease_expires_at > now()
          RETURNING ${taskColumns}
        `,
        [
          input.taskId,
          input.workerId,
          input.generation,
          input.status,
          JSON.stringify(input.result),
        ],
      );
      const task = taskResult.rows[0];

      if (!task) {
        await client.query('COMMIT');
        return null;
      }

      await appendEvent(client, {
        workflowId: task.workflow_id,
        taskId: task.id,
        eventType: input.eventType,
        data: {
          workerId: input.workerId,
          generation: input.generation,
          result: input.result,
        },
      });

      if (input.status === 'completed') {
        await advanceWorkflow(client, task);
      }

      await client.query('COMMIT');
      return mapTask(task);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

const taskColumns = `
  id, workflow_id, step_number, name, handler, status, payload, result,
  max_attempts, attempt_count, lease_owner, lease_expires_at,
  generation, next_attempt_at, created_at, updated_at, completed_at
`;

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

    const handler = step.handler ?? 'noop';
    if (!/^[a-z][a-z0-9._-]{0,119}$/.test(handler)) {
      throw new InvalidWorkflowDefinitionError(
        `Step ${index + 1} handler must be a lowercase handler identifier`,
      );
    }
  }
}

function validateLeaseSettings(workerId: string, leaseDurationMs: number): void {
  validateWorkerId(workerId);
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 100 || leaseDurationMs > 3_600_000) {
    throw new RangeError('leaseDurationMs must be an integer between 100 and 3600000');
  }
}

function validateWorkerId(workerId: string): void {
  if (workerId.trim().length === 0 || workerId.length > 200) {
    throw new RangeError('workerId must contain 1 to 200 characters');
  }
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new RangeError('generation must be a positive safe integer');
  }
}

async function advanceWorkflow(client: PoolClient, completedTask: TaskRow): Promise<void> {
  const nextTaskResult = await client.query<NextTaskRow>(
    `
      SELECT id, status, step_number
      FROM tasks
      WHERE workflow_id = $1 AND step_number = $2
      FOR UPDATE
    `,
    [completedTask.workflow_id, completedTask.step_number + 1],
  );
  const nextTask = nextTaskResult.rows[0];

  if (nextTask) {
    const activated = await client.query(
      `
        UPDATE tasks
        SET status = 'ready', updated_at = now()
        WHERE id = $1 AND status = 'blocked'
      `,
      [nextTask.id],
    );
    if (activated.rowCount !== 1) {
      throw new Error(
        `Cannot activate task ${nextTask.id} from unexpected status ${nextTask.status}`,
      );
    }

    await appendEvent(client, {
      workflowId: completedTask.workflow_id,
      taskId: nextTask.id,
      eventType: 'task.ready',
      data: {
        stepNumber: nextTask.step_number,
        previousTaskId: completedTask.id,
      },
    });
    return;
  }

  const completedWorkflow = await client.query(
    `
      UPDATE workflows
      SET
        status = 'completed',
        version = version + 1,
        updated_at = now(),
        completed_at = now()
      WHERE id = $1 AND status = 'running'
    `,
    [completedTask.workflow_id],
  );
  if (completedWorkflow.rowCount !== 1) {
    throw new Error(`Workflow ${completedTask.workflow_id} was not running at final completion`);
  }

  await appendEvent(client, {
    workflowId: completedTask.workflow_id,
    eventType: 'workflow.status_changed',
    data: { from: 'running', to: 'completed' },
  });
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
    [input.workflowId, input.taskId ?? null, sequence, input.eventType, JSON.stringify(input.data)],
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
          id, workflow_id, step_number, name, handler, status, payload, result,
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
    handler: row.handler,
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
