import { Pool } from 'pg';

export {
  InvalidOperatorActionError,
  InvalidStateTransitionError,
  InvalidWorkflowDefinitionError,
  WorkflowRepository,
  WorkflowVersionConflictError,
} from './workflow-repository.js';
export { runMigrations } from './migrations.js';
export { IdempotencyConflictError, IdempotencyRepository } from './idempotency-repository.js';
export {
  WorkerPresenceRepository,
  type ReportWorkerPresenceInput,
} from './worker-presence-repository.js';
export { verifyWorkflowHistory } from './workflow-history.js';

export function createDatabasePool(
  connectionString: string,
  options: { maxConnections?: number } = {},
): Pool {
  return new Pool({
    connectionString,
    application_name: 'sentinel',
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export type { Pool };
