import { Pool } from 'pg';

export {
  InvalidStateTransitionError,
  InvalidWorkflowDefinitionError,
  WorkflowRepository,
} from './workflow-repository.js';
export { runMigrations } from './migrations.js';
export { IdempotencyConflictError, IdempotencyRepository } from './idempotency-repository.js';
export { verifyWorkflowHistory } from './workflow-history.js';

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    application_name: 'sentinel',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export type { Pool };
