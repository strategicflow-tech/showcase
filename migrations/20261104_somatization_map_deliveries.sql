CREATE TABLE IF NOT EXISTS somatization_map_deliveries (
  checkout_session_id TEXT PRIMARY KEY,
  stripe_event_id TEXT NOT NULL,
  program TEXT NOT NULL CHECK (program IN ('p1', 'p2', 'p3', 'p4', 'pack')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  resend_message_id TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS somatization_map_deliveries_created_idx
  ON somatization_map_deliveries (created_at DESC);
