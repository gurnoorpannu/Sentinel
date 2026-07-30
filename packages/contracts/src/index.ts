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

export const failureInjectionModes = [
  'retryable',
  'permanent',
  'hang',
  'crash_before_effect',
  'crash_after_effect',
] as const;

export type FailureInjectionMode = (typeof failureInjectionModes)[number];

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface WorkflowStepDefinition {
  name: string;
  handler?: string;
  compensationHandler?: string;
  payload?: JsonObject;
  maxAttempts?: number;
}

export interface CreateWorkflowInput {
  name: string;
  payload?: JsonObject;
  steps: WorkflowStepDefinition[];
}

export interface Workflow {
  id: string;
  name: string;
  status: WorkflowStatus;
  payload: JsonObject;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface WorkflowSummary {
  workflow: Workflow;
  taskCount: number;
  completedTaskCount: number;
  activeTaskCount: number;
  failedTaskCount: number;
}

export interface ListWorkflowsInput {
  status?: WorkflowStatus | undefined;
  limit?: number;
}

export interface Task {
  id: string;
  workflowId: string;
  stepNumber: number;
  name: string;
  handler: string;
  compensationHandler: string | null;
  executionMode: 'forward' | 'compensation';
  status: TaskStatus;
  payload: JsonObject;
  result: JsonValue | null;
  maxAttempts: number;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  generation: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface WorkflowEvent {
  id: string;
  workflowId: string;
  taskId: string | null;
  sequence: number;
  eventType: string;
  data: JsonObject;
  occurredAt: Date;
}

export interface WorkflowHistoryIssue {
  code:
    | 'SEQUENCE_GAP'
    | 'EVENT_COUNT_MISMATCH'
    | 'INVALID_WORKFLOW_TRANSITION'
    | 'INVALID_TASK_TRANSITION'
    | 'MISSING_TASK_REFERENCE'
    | 'WORKFLOW_PROJECTION_MISMATCH'
    | 'TASK_PROJECTION_MISMATCH';
  message: string;
  sequence?: number;
  taskId?: string;
}

export interface WorkflowHistoryReport {
  workflowId: string;
  valid: boolean;
  eventCount: number;
  latestSequence: number;
  replayedWorkflowStatus: WorkflowStatus;
  replayedTaskStatuses: Array<{ taskId: string; status: TaskStatus }>;
  issues: WorkflowHistoryIssue[];
}

export interface WorkflowDetail {
  workflow: Workflow;
  tasks: Task[];
  events: WorkflowEvent[];
}

export interface ClaimTaskInput {
  workerId: string;
  leaseDurationMs: number;
}

export interface LeaseIdentity {
  taskId: string;
  workerId: string;
  generation: number;
}

export interface RenewLeaseInput extends LeaseIdentity {
  leaseDurationMs: number;
}

export interface CompleteTaskInput extends LeaseIdentity {
  result: JsonValue;
}

export interface FailTaskInput extends LeaseIdentity {
  error: JsonObject;
  retryable: boolean;
  retryDelayMs: number;
}

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
  leased: ['completed', 'retry_scheduled', 'failed', 'compensated', 'compensation_failed'],
  retry_scheduled: ['leased'],
  completed: ['compensating'],
  failed: [],
  compensating: ['leased'],
  compensated: [],
  compensation_failed: [],
};

export function canTransitionWorkflow(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return workflowTransitions[from].includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].includes(to);
}
