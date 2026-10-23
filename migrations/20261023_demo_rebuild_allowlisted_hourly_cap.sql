-- Persist the rolling hourly reservations for allowlisted demo rebuild keys.
-- The development schema is applied through the workspace database flow;
-- Replit Publish propagates this additive table/index to production.

CREATE TABLE IF NOT EXISTS demo_rebuild_allowlisted_attempts (
  id            BIGSERIAL PRIMARY KEY,
  write_key_id  UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS demo_rebuild_allowlisted_attempts_key_created_idx
  ON demo_rebuild_allowlisted_attempts (write_key_id, created_at);
