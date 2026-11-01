-- v0.4.1: the task Idempotency-Key is bound to a hash of the request body. A replay with
-- the same key and another body is refused (422) instead of returning the first task.
-- Rows created before this column have NULL and are never treated as a mismatch.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_hash text;
