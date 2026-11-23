-- Store only keyed hashes of client IPs and one row per free pre-send check.
-- Replit Publish propagates this additive table and indexes to production.

CREATE TABLE IF NOT EXISTS presend_weekly_check_events (
  id            UUID PRIMARY KEY,
  ip_hash       CHAR(64) NOT NULL,
  token_hash    CHAR(64) NOT NULL UNIQUE,
  token_used_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_presend_weekly_check_events_ip_created
  ON presend_weekly_check_events (ip_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_presend_weekly_check_events_created
  ON presend_weekly_check_events (created_at);
