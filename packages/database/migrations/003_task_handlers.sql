ALTER TABLE tasks
ADD COLUMN handler text NOT NULL DEFAULT 'noop'
CHECK (handler ~ '^[a-z][a-z0-9._-]{0,119}$');

CREATE INDEX tasks_handler_idx ON tasks (handler);
