CREATE TABLE system_metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_metadata (key, value)
VALUES ('schema', '{"phase": 1, "name": "foundation"}'::jsonb);
