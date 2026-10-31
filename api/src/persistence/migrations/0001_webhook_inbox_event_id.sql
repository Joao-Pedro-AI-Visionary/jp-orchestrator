-- v0.3.2: receiver dedupe. A redelivered event (same X-JP-Event-Id) is stored once.
ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS event_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_inbox_event_id_key') THEN
    ALTER TABLE webhook_inbox ADD CONSTRAINT webhook_inbox_event_id_key UNIQUE (event_id);
  END IF;
END $$;
