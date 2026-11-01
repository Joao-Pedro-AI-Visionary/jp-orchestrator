-- v0.4.0: one runner per task across replicas (lease) and atomic budget reservation.
-- lease_owner/lease_until: claimed atomically before a run, renewed by heartbeat, cleared on exit.
-- reserved_usd: estimated cost of in-flight model calls; spent + reserved never passes budget.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reserved_usd numeric(14,6) NOT NULL DEFAULT 0;
