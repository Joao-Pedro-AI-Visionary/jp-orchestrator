-- v0.5.0: who decided an approval, and the request fingerprint stored with an Idempotency-Key.
-- decided_by is the API key principal (NULL for decisions taken before v0.5.0).
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_by text;
-- sha256 of the normalized POST /tasks body: the same key with a different body is refused (422).
-- NULL for keys stored before v0.5.0, which keep replaying as before.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
