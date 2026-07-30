CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'running',
        'compensating',
        'completed',
        'failed',
        'compensated',
        'compensation_failed'
      )
    ),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  event_sequence bigint NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK (updated_at >= created_at),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_number integer NOT NULL CHECK (step_number > 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL
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
        'compensation_failed'
      )
    ),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  result jsonb,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
  lease_owner text,
  lease_expires_at timestamptz,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workflow_id, step_number),
  CHECK (updated_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    status = 'leased'
    OR (lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    status = 'retry_scheduled'
    OR next_attempt_at IS NULL
  )
);

CREATE TABLE workflow_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, sequence)
);

CREATE INDEX workflows_status_created_idx
  ON workflows (status, created_at DESC);

CREATE INDEX tasks_workflow_step_idx
  ON tasks (workflow_id, step_number);

CREATE INDEX tasks_claimable_idx
  ON tasks (next_attempt_at, created_at)
  WHERE status IN ('ready', 'retry_scheduled');

CREATE INDEX tasks_expired_lease_idx
  ON tasks (lease_expires_at)
  WHERE status = 'leased';

CREATE INDEX workflow_events_timeline_idx
  ON workflow_events (workflow_id, sequence);
