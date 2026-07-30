import type { WorkflowEvent } from '@sentinel/contracts';
import { describe, expect, it } from 'vitest';

import { verifyWorkflowHistory } from './workflow-history.js';

describe('workflow history replay', () => {
  it('reconstructs completed workflow and task projections', () => {
    const report = verifyWorkflowHistory({
      workflowId: 'workflow-1',
      workflowStatus: 'completed',
      eventSequence: 6,
      tasks: [{ id: 'task-1', status: 'completed' }],
      events: [
        event(1, 'workflow.created'),
        event(2, 'task.created', 'task-1', { status: 'ready' }),
        event(3, 'workflow.status_changed', null, { from: 'pending', to: 'running' }),
        event(4, 'task.leased', 'task-1'),
        event(5, 'task.completed', 'task-1'),
        event(6, 'workflow.status_changed', null, { from: 'running', to: 'completed' }),
      ],
    });

    expect(report).toMatchObject({
      valid: true,
      latestSequence: 6,
      replayedWorkflowStatus: 'completed',
      replayedTaskStatuses: [{ taskId: 'task-1', status: 'completed' }],
      issues: [],
    });
  });

  it('detects sequence gaps and projection divergence', () => {
    const report = verifyWorkflowHistory({
      workflowId: 'workflow-1',
      workflowStatus: 'failed',
      eventSequence: 4,
      tasks: [{ id: 'task-1', status: 'failed' }],
      events: [
        event(1, 'workflow.created'),
        event(2, 'task.created', 'task-1', { status: 'ready' }),
        event(4, 'task.completed', 'task-1'),
      ],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'SEQUENCE_GAP',
        'EVENT_COUNT_MISMATCH',
        'WORKFLOW_PROJECTION_MISMATCH',
        'TASK_PROJECTION_MISMATCH',
      ]),
    );
  });

  it('rejects task transitions that precede task creation', () => {
    const report = verifyWorkflowHistory({
      workflowId: 'workflow-1',
      workflowStatus: 'pending',
      eventSequence: 1,
      tasks: [],
      events: [event(1, 'task.leased', 'task-missing')],
    });

    expect(report.issues[0]?.code).toBe('MISSING_TASK_REFERENCE');
  });
});

function event(
  sequence: number,
  eventType: string,
  taskId: string | null = null,
  data: Record<string, string | number | boolean | null> = {},
): WorkflowEvent {
  return {
    id: String(sequence),
    workflowId: 'workflow-1',
    taskId,
    sequence,
    eventType,
    data,
    occurredAt: new Date('2026-07-30T00:00:00.000Z'),
  };
}
