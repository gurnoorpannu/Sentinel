ALTER TABLE workflows
DROP CONSTRAINT workflows_status_check;

ALTER TABLE workflows
ADD CONSTRAINT workflows_status_check
CHECK (
  status IN (
    'pending',
    'running',
    'compensating',
    'completed',
    'failed',
    'compensated',
    'compensation_failed',
    'canceled'
  )
);

ALTER TABLE tasks
DROP CONSTRAINT tasks_status_check;

ALTER TABLE tasks
ADD CONSTRAINT tasks_status_check
CHECK (
  status IN (
    'blocked',
    'ready',
    'leased',
    'retry_scheduled',
    'completed',
    'failed',
    'compensating',
    'compensated',
    'compensation_failed',
    'canceled'
  )
);

CREATE TABLE operator_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  action text NOT NULL
    CHECK (action IN ('retry_failed_task', 'retry_compensation', 'cancel')),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  expected_version bigint NOT NULL CHECK (expected_version > 0),
  resulting_version bigint NOT NULL CHECK (resulting_version > expected_version),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operator_actions_workflow_created_idx
  ON operator_actions (workflow_id, created_at DESC);

UPDATE system_metadata
SET value = '{"phase": 10, "name": "operator-controls"}'::jsonb,
    updated_at = now()
WHERE key = 'schema';
