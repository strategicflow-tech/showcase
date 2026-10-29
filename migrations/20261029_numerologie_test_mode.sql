ALTER TABLE numerologie_deliveries
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS numerologie_test_send_attempts (
  id BIGSERIAL PRIMARY KEY,
  delivery_id BIGINT NOT NULL REFERENCES numerologie_deliveries(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS numerologie_test_send_attempts_created_idx
  ON numerologie_test_send_attempts (created_at DESC);
