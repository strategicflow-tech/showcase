CREATE TABLE IF NOT EXISTS somatization_map_reviews (
  id BIGSERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  email TEXT NOT NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('ro', 'en', 'es', 'fr')),
  status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'confirmed', 'approved', 'rejected')),
  confirmation_token_hash TEXT NOT NULL,
  confirmation_expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  consent_at TIMESTAMPTZ NOT NULL,
  ip_hash TEXT NOT NULL,
  moderation_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS somatization_map_reviews_one_active_email
  ON somatization_map_reviews (email)
  WHERE status IN ('pending_confirmation', 'confirmed', 'approved');
CREATE INDEX IF NOT EXISTS somatization_map_reviews_status_created
  ON somatization_map_reviews (status, created_at DESC);
