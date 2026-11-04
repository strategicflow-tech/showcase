CREATE TABLE IF NOT EXISTS somatization_map_subscribers (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL CONSTRAINT somatization_map_subscribers_email_key UNIQUE,
  lang TEXT NOT NULL CHECK (lang IN ('en', 'ro', 'es', 'fr')),
  consent_at TIMESTAMPTZ NOT NULL,
  ip_hash TEXT NOT NULL,
  send_status TEXT NOT NULL CHECK (send_status IN ('sending', 'sent', 'failed')),
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
