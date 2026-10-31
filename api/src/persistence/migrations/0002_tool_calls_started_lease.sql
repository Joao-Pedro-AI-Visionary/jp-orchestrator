-- v0.3.2: tool calls are claimed ('started' + lease) before the handler runs.
-- Rows written by earlier versions always held a result, so they backfill as 'completed'.
-- The default stays 'completed' so an older instance still running during a rolling deploy
-- (which inserts without status) writes valid rows. The new code always sets status explicitly.
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed';
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 1;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE tool_calls ALTER COLUMN result DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_calls_status_check') THEN
    ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_status_check
      CHECK (status IN ('started', 'completed') AND (status = 'started' OR result IS NOT NULL));
  END IF;
END $$;
