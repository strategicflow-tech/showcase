-- Additive DFM execution layer: stored audit records, write-scoped API keys,
-- and an attempt log that records both successful and failed write triggers.

CREATE TABLE IF NOT EXISTS decision_audit_records (
  id                UUID PRIMARY KEY,
  source            TEXT NOT NULL,
  diagnosis         JSONB NOT NULL,
  structured_fixes  JSONB NOT NULL CHECK (jsonb_typeof(structured_fixes) = 'array'),
  field_values      JSONB NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(field_values) = 'object'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_audit_records_created
  ON decision_audit_records (created_at DESC);

CREATE TABLE IF NOT EXISTS execution_write_api_keys (
  id          UUID PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,
  key_name    TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope = 'decision_audit.write'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS decision_execution_attempts (
  id                           BIGSERIAL PRIMARY KEY,
  request_id                   UUID NOT NULL UNIQUE,
  record_id                    TEXT,
  fix_id                       TEXT,
  field_name                   TEXT,
  attempted_before             TEXT,
  attempted_after              TEXT,
  observed_before              TEXT,
  observed_after               TEXT,
  trigger_evaluated            BOOLEAN NOT NULL DEFAULT FALSE,
  trigger_matched              BOOLEAN,
  precondition_failure_reason  TEXT,
  write_attempted              BOOLEAN NOT NULL DEFAULT FALSE,
  write_succeeded              BOOLEAN NOT NULL DEFAULT FALSE,
  verification_succeeded       BOOLEAN NOT NULL DEFAULT FALSE,
  failure_reason               TEXT,
  http_status                  INTEGER,
  write_key_id                 UUID REFERENCES execution_write_api_keys(id) ON DELETE SET NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_execution_attempts_record_created
  ON decision_execution_attempts (record_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_execution_attempts_created
  ON decision_execution_attempts (created_at DESC);