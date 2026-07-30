ALTER TABLE tasks
ADD COLUMN compensation_handler text
CHECK (
  compensation_handler IS NULL
  OR compensation_handler ~ '^[a-z][a-z0-9._-]{0,119}$'
);

ALTER TABLE tasks
ADD COLUMN execution_mode text NOT NULL DEFAULT 'forward'
CHECK (execution_mode IN ('forward', 'compensation'));
