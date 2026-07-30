export const workflowStatuses = [
  'pending',
  'running',
  'compensating',
  'completed',
  'failed',
  'compensated',
  'compensation_failed',
] as const;

export type WorkflowStatus = (typeof workflowStatuses)[number];

export const taskStatuses = [
  'blocked',
  'ready',
  'leased',
  'retry_scheduled',
  'completed',
  'failed',
  'compensating',
  'compensated',
  'compensation_failed',
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export const workflowTransitions: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  pending: ['running'],
  running: ['completed', 'compensating', 'failed'],
  compensating: ['compensated', 'compensation_failed'],
  completed: [],
  failed: [],
  compensated: [],
  compensation_failed: [],
};

export const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  blocked: ['ready'],
  ready: ['leased'],
  leased: ['completed', 'retry_scheduled', 'failed'],
  retry_scheduled: ['ready'],
  completed: ['compensating'],
  failed: [],
  compensating: ['compensated', 'compensation_failed'],
  compensated: [],
  compensation_failed: [],
};

export function canTransitionWorkflow(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return workflowTransitions[from].includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].includes(to);
}
