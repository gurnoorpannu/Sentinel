CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY CHECK (length(worker_id) BETWEEN 1 AND 200),
  concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 64),
  in_flight integer NOT NULL CHECK (in_flight >= 0 AND in_flight <= concurrency),
  stopping boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX worker_heartbeats_updated_idx
  ON worker_heartbeats (updated_at DESC);

UPDATE system_metadata
SET value = '{"phase": 11, "name": "scalability"}'::jsonb,
    updated_at = now()
WHERE key = 'schema';
