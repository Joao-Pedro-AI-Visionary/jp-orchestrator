-- JP Orchestrator schema. Idempotent: safe to run on every boot.
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL,
  budget_usd numeric(14,6) NOT NULL,
  spent_usd numeric(14,6) NOT NULL DEFAULT 0,
  requires_approval boolean NOT NULL DEFAULT false,
  correction_rounds int NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);

CREATE TABLE IF NOT EXISTS subtasks (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent text NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  model text,
  output text,
  attempt int NOT NULL DEFAULT 1,
  position int NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS subtasks_task_idx ON subtasks (task_id);

CREATE TABLE IF NOT EXISTS step_journal (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  value jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, step_key)
);

CREATE TABLE IF NOT EXISTS approvals (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  status text NOT NULL,
  note text,
  requested_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS tool_calls (
  idempotency_key text PRIMARY KEY,
  task_id uuid NOT NULL,
  subtask_id uuid,
  tool text NOT NULL,
  args jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS usage_records (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL,
  subtask_id uuid,
  agent text NOT NULL,
  model text NOT NULL,
  prompt_tokens int NOT NULL,
  completion_tokens int NOT NULL,
  cost_usd numeric(14,6) NOT NULL,
  saved_usd numeric(14,6) NOT NULL DEFAULT 0,
  cached boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_task_idx ON usage_records (task_id);

CREATE TABLE IF NOT EXISTS context_snapshots (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version int NOT NULL,
  hash text NOT NULL,
  parent_hash text,
  label text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, version)
);

CREATE TABLE IF NOT EXISTS webhook_inbox (
  id uuid PRIMARY KEY,
  event text NOT NULL,
  verified boolean NOT NULL,
  signature text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
