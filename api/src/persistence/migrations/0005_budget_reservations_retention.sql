-- v0.6.0: atomic budget reservation. A gateway call reserves its worst-case cost before
-- calling the model; reserved_usd counts against the budget until the call settles
-- (usage recorded, reservation removed) or fails (reservation released).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reserved_usd numeric(14,6) NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS budget_reservations (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  amount_usd numeric(14,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budget_reservations_task_idx ON budget_reservations (task_id);

-- Retention job (RETENTION_MS) and billing aggregation scan these by time.
CREATE INDEX IF NOT EXISTS webhook_inbox_received_idx ON webhook_inbox (received_at);
CREATE INDEX IF NOT EXISTS tool_calls_created_idx ON tool_calls (created_at);
CREATE INDEX IF NOT EXISTS step_journal_created_idx ON step_journal (created_at);
CREATE INDEX IF NOT EXISTS usage_created_idx ON usage_records (created_at, id);
