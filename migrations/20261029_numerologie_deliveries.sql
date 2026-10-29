CREATE TABLE IF NOT EXISTS numerologie_deliveries (
  id BIGSERIAL PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  checkout_session_id TEXT NOT NULL UNIQUE,
  buyer_email TEXT NOT NULL,
  pack TEXT NOT NULL CHECK (pack IN ('numdeep', 'nlpdeep', 'crosspro', 'bundle')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  resend_message_id TEXT,
  locale TEXT,
  billing_country TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS numerologie_deliveries_created_idx
  ON numerologie_deliveries (created_at DESC);
CREATE INDEX IF NOT EXISTS numerologie_deliveries_status_idx
  ON numerologie_deliveries (status, created_at);
