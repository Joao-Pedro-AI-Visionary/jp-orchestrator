-- v0.4.0: per-task execution lease and terminal 'failed' tool calls.
-- Lease: only the owner runs a task. lease_token is the fencing token, bumped on every
-- acquisition, so writes from a previous owner (a zombie run or another replica) are refused.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_token bigint NOT NULL DEFAULT 0;

-- Tool calls: 'failed' is terminal (attempts or key TTL exhausted) and keeps the reason in error.
-- A clean failure now clears lease_until (NULL) instead of expiring it, so the retry keeps its
-- attempt number. No row written by v0.3.x has a NULL lease while 'started', so none changes meaning.
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_status_check;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_status_check
  CHECK (status IN ('started', 'completed', 'failed') AND (status <> 'completed' OR result IS NOT NULL));
