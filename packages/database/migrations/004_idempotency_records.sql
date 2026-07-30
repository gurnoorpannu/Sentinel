CREATE TABLE idempotency_records (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 300),
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 120),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_records_operation_idx
  ON idempotency_records (operation, created_at DESC);
