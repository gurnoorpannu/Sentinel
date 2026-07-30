import {
  taskStatuses,
  workflowStatuses,
  type TaskStatus,
  type WorkflowEvent,
  type WorkflowHistoryIssue,
  type WorkflowHistoryReport,
  type WorkflowStatus,
} from '@sentinel/contracts';

interface ProjectionTask {
  id: string;
  status: TaskStatus;
}

interface VerifyWorkflowHistoryInput {
  workflowId: string;
  workflowStatus: WorkflowStatus;
  eventSequence: number;
  tasks: ProjectionTask[];
  events: WorkflowEvent[];
}

const taskEventStatuses: Readonly<Record<string, TaskStatus | undefined>> = {
  'task.ready': 'ready',
  'task.leased': 'leased',
  'task.reclaimed': 'leased',
  'task.retried': 'leased',
  'task.completed': 'completed',
  'task.retry_scheduled': 'retry_scheduled',
  'task.failed': 'failed',
  'task.compensation_ready': 'compensating',
  'task.compensation_leased': 'leased',
  'task.compensation_reclaimed': 'leased',
  'task.compensation_retried': 'leased',
  'task.compensated': 'compensated',
  'task.compensation_failed': 'compensation_failed',
  'task.canceled': 'canceled',
};

export function verifyWorkflowHistory(input: VerifyWorkflowHistoryInput): WorkflowHistoryReport {
  const issues: WorkflowHistoryIssue[] = [];
  let replayedWorkflowStatus: WorkflowStatus = 'pending';
  const replayedTasks = new Map<string, TaskStatus>();

  for (const [index, event] of input.events.entries()) {
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      issues.push({
        code: 'SEQUENCE_GAP',
        message: `Expected event sequence ${expectedSequence}, received ${event.sequence}`,
        sequence: event.sequence,
      });
    }

    if (event.eventType === 'workflow.status_changed') {
      const nextStatus = event.data.to;
      if (!isWorkflowStatus(nextStatus)) {
        issues.push({
          code: 'INVALID_WORKFLOW_TRANSITION',
          message: `Event ${event.sequence} has invalid workflow status ${String(nextStatus)}`,
          sequence: event.sequence,
        });
      } else {
        replayedWorkflowStatus = nextStatus;
      }
      continue;
    }

    if (event.eventType === 'task.created') {
      if (!event.taskId) {
        issues.push(missingTaskReference(event));
        continue;
      }
      const initialStatus = event.data.status;
      if (!isTaskStatus(initialStatus)) {
        issues.push({
          code: 'INVALID_TASK_TRANSITION',
          message: `Event ${event.sequence} has invalid initial task status ${String(initialStatus)}`,
          sequence: event.sequence,
          taskId: event.taskId,
        });
      } else {
        replayedTasks.set(event.taskId, initialStatus);
      }
      continue;
    }

    const taskStatus = taskEventStatuses[event.eventType];
    if (taskStatus) {
      if (!event.taskId) {
        issues.push(missingTaskReference(event));
      } else if (!replayedTasks.has(event.taskId)) {
        issues.push({
          code: 'MISSING_TASK_REFERENCE',
          message: `Event ${event.sequence} references task ${event.taskId} before creation`,
          sequence: event.sequence,
          taskId: event.taskId,
        });
      } else {
        replayedTasks.set(event.taskId, taskStatus);
      }
    }
  }

  if (input.eventSequence !== input.events.length) {
    issues.push({
      code: 'EVENT_COUNT_MISMATCH',
      message: `Workflow counter is ${input.eventSequence}, but ${input.events.length} events exist`,
    });
  }

  if (replayedWorkflowStatus !== input.workflowStatus) {
    issues.push({
      code: 'WORKFLOW_PROJECTION_MISMATCH',
      message: `History replays workflow as ${replayedWorkflowStatus}, projection is ${input.workflowStatus}`,
    });
  }

  for (const task of input.tasks) {
    const replayedStatus = replayedTasks.get(task.id);
    if (replayedStatus !== task.status) {
      issues.push({
        code: 'TASK_PROJECTION_MISMATCH',
        message: `History replays task ${task.id} as ${replayedStatus ?? 'missing'}, projection is ${task.status}`,
        taskId: task.id,
      });
    }
  }

  return {
    workflowId: input.workflowId,
    valid: issues.length === 0,
    eventCount: input.events.length,
    latestSequence: input.events.at(-1)?.sequence ?? 0,
    replayedWorkflowStatus,
    replayedTaskStatuses: [...replayedTasks].map(([taskId, status]) => ({ taskId, status })),
    issues,
  };
}

function missingTaskReference(event: WorkflowEvent): WorkflowHistoryIssue {
  return {
    code: 'MISSING_TASK_REFERENCE',
    message: `Task event ${event.sequence} has no task reference`,
    sequence: event.sequence,
  };
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && workflowStatuses.includes(value as WorkflowStatus);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && taskStatuses.includes(value as TaskStatus);
}
