'use strict';

const crypto = require('node:crypto');
const express = require('express');

const WRITE_SCOPE = 'decision_audit.write';
const WRITE_KEY_RATE_LIMIT = 60;
const WRITE_KEY_RATE_WINDOW_SECONDS = 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIX_ID_RE = /^fx_[a-f0-9]{10}$/i;

const PATTERN_FIELDS = Object.freeze({
  'Guest Language CTA': 'cta_text',
  'Feature-First Bias': 'lead_text',
  'Filing Label Subject': 'subject_line',
  'Consequence-After-Caveat': 'opening_text',
  'Missing Visual Hierarchy': 'visual_hierarchy',
  'Zero/Buried Social Proof': 'social_proof',
  'Generic Urgency Theatre': 'urgency_text',
});

const FIELD_PATTERNS = Object.freeze(Object.fromEntries(
  Object.entries(PATTERN_FIELDS).map(([pattern, fieldName]) => [fieldName, pattern])
));

const ALLOWED_FIELD_NAMES = new Set([
  ...Object.values(PATTERN_FIELDS),
  'feature_outcome',
  'transformation',
  'body_text',
]);

function canonicalPattern(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return Object.keys(PATTERN_FIELDS).find(
    pattern => pattern.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized
  ) || null;
}

function inferFieldName(change) {
  const pattern = canonicalPattern(change.pattern);
  if (pattern) return PATTERN_FIELDS[pattern];

  if (typeof change.field_name === 'string' && ALLOWED_FIELD_NAMES.has(change.field_name)) {
    return change.field_name;
  }

  const element = `${change.element || ''} ${change.label || ''}`.toLowerCase();
  if (/call.?to.?action|\bcta\b|button/.test(element)) return 'cta_text';
  if (/subject/.test(element)) return 'subject_line';
  if (/proof|testimonial|social/.test(element)) return 'social_proof';
  if (/urgency|deadline|time pressure/.test(element)) return 'urgency_text';
  if (/visual|hierarch|layout/.test(element)) return 'visual_hierarchy';
  if (/transformation|before.?after|contrast/.test(element)) return 'transformation';
  if (/feature|outcome|benefit/.test(element)) return 'feature_outcome';
  if (/caveat|consequence|opening|hook|lead|intro/.test(element)) return 'opening_text';
  if (/body|paragraph|copy/.test(element)) return 'body_text';
  return null;
}

function getChangeValue(change, primary, secondary) {
  if (typeof change[primary] === 'string') return change[primary];
  if (typeof change[secondary] === 'string') return change[secondary];
  return null;
}

function createStructuredFixes(diagnosis, { idFactory = () => `fx_${crypto.randomBytes(5).toString('hex')}` } = {}) {
  if (!diagnosis || typeof diagnosis !== 'object' || Array.isArray(diagnosis)) {
    throw new TypeError('Diagnosis must be an object');
  }

  const changes = Array.isArray(diagnosis.changes) ? diagnosis.changes.slice() : [];
  const hasCtaChange = changes.some(change => change && inferFieldName(change) === 'cta_text');
  const ctaSource = diagnosis.cta_rewrite;
  if (!hasCtaChange && ctaSource && typeof ctaSource === 'object' && !Array.isArray(ctaSource)) {
    changes.push({
      element: 'CTA',
      pattern: 'Guest Language CTA',
      before: getChangeValue(ctaSource, 'before_value', 'before'),
      after: getChangeValue(ctaSource, 'after_value', 'after') || diagnosis.rebuilt_cta,
      why: ctaSource.why,
    });
  }

  const fixes = changes.map((change, index) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      throw new TypeError(`Change ${index + 1} must be an object`);
    }

    const fieldName = inferFieldName(change);
    if (!fieldName || !ALLOWED_FIELD_NAMES.has(fieldName)) {
      throw new TypeError(`Change ${index + 1} has no supported field name`);
    }

    const beforeValue = getChangeValue(change, 'before', 'before_value');
    let afterValue = getChangeValue(change, 'after', 'after_value');
    if (fieldName === 'cta_text' && typeof diagnosis.rebuilt_cta === 'string') {
      afterValue = diagnosis.rebuilt_cta;
    }
    if (beforeValue === null || afterValue === null) {
      throw new TypeError(`Change ${index + 1} must include string before and after values`);
    }

    const pattern = canonicalPattern(change.pattern) || FIELD_PATTERNS[fieldName] || 'Other';
    const fixId = idFactory();
    if (typeof fixId !== 'string' || !FIX_ID_RE.test(fixId)) {
      throw new TypeError('Fix id factory returned an invalid id');
    }

    return {
      fix_id: fixId,
      field_name: fieldName,
      before_value: beforeValue,
      after_value: afterValue,
      pattern,
      element: typeof change.element === 'string' ? change.element : fieldName,
      why: typeof change.why === 'string' ? change.why : '',
    };
  });

  if (typeof diagnosis.rebuilt_cta === 'string' &&
      !fixes.some(fix => fix.field_name === 'cta_text')) {
    throw new TypeError('Diagnosis must include a structured CTA fix');
  }

  return fixes;
}

function attachStructuredFixes(diagnosis, options) {
  const structuredFixes = createStructuredFixes(diagnosis, options);
  const ctaFix = structuredFixes.find(fix => fix.field_name === 'cta_text');
  return {
    ...diagnosis,
    cta_rewrite: ctaFix ? { ...ctaFix } : null,
    structured_fixes: structuredFixes,
  };
}

async function persistDecisionAuditRecord(pool, { source, diagnosis }) {
  if (!diagnosis || !Array.isArray(diagnosis.structured_fixes)) {
    throw new TypeError('Diagnosis must include structured fixes');
  }

  const recordId = crypto.randomUUID();
  const fieldValues = Object.fromEntries(
    diagnosis.structured_fixes.map(fix => [fix.fix_id, fix.before_value])
  );

  await pool.query(`
    INSERT INTO decision_audit_records
      (id, source, diagnosis, structured_fixes, field_values)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
  `, [
    recordId,
    source,
    JSON.stringify(diagnosis),
    JSON.stringify(diagnosis.structured_fixes),
    JSON.stringify(fieldValues),
  ]);

  return recordId;
}

function hashWriteKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function sameSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' ||
      !provided || !expected) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorizeAdminRequest(req, res, adminKey) {
  if (!adminKey) {
    res.status(503).json({ error: 'admin_issuer_not_configured' });
    return false;
  }
  if (!sameSecret(req.get('x-admin-key'), adminKey)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function boundedText(value, maxLength = 12000) {
  return typeof value === 'string' ? value.slice(0, maxLength) : null;
}

function makeAttempt(recordId, fixId) {
  return {
    request_id: crypto.randomUUID(),
    record_id: boundedText(recordId, 120),
    fix_id: boundedText(fixId, 80),
    field_name: null,
    attempted_before: null,
    attempted_after: null,
    observed_before: null,
    observed_after: null,
    trigger_evaluated: false,
    trigger_matched: null,
    precondition_failure_reason: null,
    write_attempted: false,
    write_succeeded: false,
    verification_succeeded: false,
    failure_reason: null,
    http_status: 500,
    write_key_id: null,
  };
}

async function insertAttempt(queryable, attempt) {
  await queryable.query(`
    INSERT INTO decision_execution_attempts
      (request_id, record_id, fix_id, field_name, attempted_before, attempted_after,
       observed_before, observed_after, trigger_evaluated, trigger_matched,
       precondition_failure_reason, write_attempted, write_succeeded,
       verification_succeeded, failure_reason, http_status, write_key_id)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    ON CONFLICT (request_id) DO NOTHING
  `, [
    attempt.request_id,
    attempt.record_id,
    attempt.fix_id,
    attempt.field_name,
    attempt.attempted_before,
    attempt.attempted_after,
    attempt.observed_before,
    attempt.observed_after,
    attempt.trigger_evaluated,
    attempt.trigger_matched,
    attempt.precondition_failure_reason,
    attempt.write_attempted,
    attempt.write_succeeded,
    attempt.verification_succeeded,
    attempt.failure_reason,
    attempt.http_status,
    attempt.write_key_id,
  ]);
}

async function logUnparsedWriteAttempt(pool, { failureReason = 'invalid_json', httpStatus = 400 } = {}) {
  const attempt = makeAttempt(null, null);
  attempt.failure_reason = failureReason;
  attempt.http_status = httpStatus;
  await insertAttempt(pool, attempt);
}

function createExecutionJsonErrorHandler({ pool } = {}) {
  if (!pool) throw new TypeError('A PostgreSQL pool is required');
  return (err, req, res, next) => {
    const isExecutionWriteJsonError =
      req.method === 'POST' &&
      req.path === '/api/execution/apply-fix' &&
      (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large');
    if (!isExecutionWriteJsonError) return next(err);

    const status = err.type === 'entity.too.large' ? 413 : 400;
    const failureReason = status === 413 ? 'payload_too_large' : 'invalid_json';
    logUnparsedWriteAttempt(pool, { failureReason, httpStatus: status })
      .catch(logError => console.error('[execution-apply-fix] invalid request log failed:', logError.message))
      .finally(() => {
        if (!res.headersSent) {
          res.status(status).json({ error: failureReason });
        }
      });
  };
}

async function enrichAttemptFromRecord(client, recordId, fixId, attempt) {
  if (!UUID_RE.test(recordId || '') || !FIX_ID_RE.test(fixId || '')) return;
  const result = await client.query(
    'SELECT structured_fixes, field_values FROM decision_audit_records WHERE id = $1',
    [recordId]
  );
  if (result.rows.length === 0) return;

  const fixes = parseJsonArray(result.rows[0].structured_fixes);
  const fix = fixes.find(item => item && item.fix_id === fixId);
  if (!fix) return;

  attempt.field_name = boundedText(fix.field_name, 80);
  attempt.attempted_before = boundedText(fix.before_value);
  attempt.attempted_after = boundedText(fix.after_value);
  const fieldValues = parseJsonObject(result.rows[0].field_values);
  attempt.observed_before = boundedText(fieldValues[fixId]);
}

function bearerKey(req) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match ? match[1] : '';
}

function createDecisionExecutionRouter({ pool, adminKey } = {}) {
  if (!pool) throw new TypeError('A PostgreSQL pool is required');
  const router = express.Router();

  router.get('/api/admin/execution-write-keys', async (req, res) => {
    if (!authorizeAdminRequest(req, res, adminKey)) return;

    try {
      const result = await pool.query(`
        SELECT k.id, k.key_name AS name, k.scope, k.created_at,
               MAX(a.created_at) AS last_used_at, k.revoked_at
        FROM execution_write_api_keys k
        LEFT JOIN decision_execution_attempts a ON a.write_key_id = k.id
        GROUP BY k.id, k.key_name, k.scope, k.created_at, k.revoked_at
        ORDER BY k.created_at DESC, k.id
      `);
      return res.json({ keys: result.rows });
    } catch (error) {
      console.error('[execution-write-key] listing failed:', error.message);
      return res.status(500).json({ error: 'key_listing_failed' });
    }
  });

  router.post('/api/admin/execution-write-keys/:id/revoke', async (req, res) => {
    if (!authorizeAdminRequest(req, res, adminKey)) return;
    const keyId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!UUID_RE.test(keyId)) return res.status(400).json({ error: 'invalid_key_id' });

    try {
      const result = await pool.query(`
        UPDATE execution_write_api_keys
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id = $1
        RETURNING id, key_name AS name, scope, created_at, revoked_at
      `, [keyId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'key_not_found' });
      }
      return res.json({ success: true, key: result.rows[0] });
    } catch (error) {
      console.error('[execution-write-key] revocation failed:', error.message);
      return res.status(500).json({ error: 'key_revocation_failed' });
    }
  });

  // Admin-only issuance: the raw key is returned once and only its SHA-256 hash
  // is stored. There is deliberately no public claim/self-serve route.
  router.post('/api/admin/execution-write-keys', async (req, res) => {
    if (!authorizeAdminRequest(req, res, adminKey)) return;

    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    if (!name) return res.status(400).json({ error: 'name_required' });

    const apiKey = `sf_exec_${crypto.randomBytes(32).toString('base64url')}`;
    try {
      const result = await pool.query(`
        INSERT INTO execution_write_api_keys (id, key_hash, key_name, scope)
        VALUES ($1, $2, $3, $4)
        RETURNING id, key_name, scope, created_at
      `, [crypto.randomUUID(), hashWriteKey(apiKey), name, WRITE_SCOPE]);
      const row = result.rows[0];
      return res.status(201).json({
        key_id: row.id,
        name: row.key_name,
        scope: row.scope,
        created_at: row.created_at,
        api_key: apiKey,
        key_returned_once: true,
      });
    } catch (error) {
      console.error('[execution-write-key] issuance failed:', error.message);
      return res.status(500).json({ error: 'key_issuance_failed' });
    }
  });

  router.post('/api/execution/apply-fix', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    const recordId = typeof body.record_id === 'string' ? body.record_id.trim() : '';
    const fixId = typeof body.fix_id === 'string' ? body.fix_id.trim() : '';
    const attempt = makeAttempt(recordId, fixId);
    let client;
    let transactionOpen = false;

    try {
      client = await pool.connect();
      await client.query('BEGIN');
      transactionOpen = true;

      const key = bearerKey(req);
      let keyRow = null;
      if (key) {
        const keyResult = await client.query(`
          SELECT id, scope, revoked_at
          FROM execution_write_api_keys
          WHERE key_hash = $1
          LIMIT 1
          FOR UPDATE
        `, [hashWriteKey(key)]);
        keyRow = keyResult.rows[0] || null;
      }

      const finish = async (status, payload) => {
        attempt.http_status = status;
        await insertAttempt(client, attempt);
        await client.query('COMMIT');
        transactionOpen = false;
        return res.status(status).json({
          precondition_failure_reason: attempt.precondition_failure_reason,
          ...payload,
        });
      };

      if (keyRow) attempt.write_key_id = keyRow.id;
      if (!keyRow || keyRow.scope !== WRITE_SCOPE || keyRow.revoked_at) {
        try {
          await enrichAttemptFromRecord(client, recordId, fixId, attempt);
        } catch (_) {}
        attempt.failure_reason = 'invalid_api_key';
        return await finish(401, { error: 'unauthorized' });
      }

      const recentAttemptsResult = await client.query(`
        SELECT COUNT(*)::int AS call_count,
               GREATEST(
                 0,
                 CEIL(EXTRACT(EPOCH FROM (MIN(created_at) + INTERVAL '1 hour' - NOW())))::int
               ) AS retry_after_seconds
        FROM decision_execution_attempts
        WHERE write_key_id = $1
          AND created_at >= NOW() - INTERVAL '1 hour'
          AND failure_reason IS DISTINCT FROM 'rate_limited'
      `, [keyRow.id]);
      const recentAttempts = recentAttemptsResult.rows[0] || {};
      if (Number(recentAttempts.call_count || 0) >= WRITE_KEY_RATE_LIMIT) {
        attempt.failure_reason = 'rate_limited';
        const retryAfterSeconds = Math.max(
          1,
          Number(recentAttempts.retry_after_seconds) || 1
        );
        res.set('Retry-After', String(retryAfterSeconds));
        return await finish(429, {
          error: 'rate_limited',
          limit: WRITE_KEY_RATE_LIMIT,
          window_seconds: WRITE_KEY_RATE_WINDOW_SECONDS,
          retry_after_seconds: retryAfterSeconds,
        });
      }

      if (!recordId || !UUID_RE.test(recordId) || !fixId || !FIX_ID_RE.test(fixId)) {
        attempt.failure_reason = 'invalid_record_or_fix_id';
        return await finish(400, { error: 'invalid_record_or_fix_id' });
      }

      const recordResult = await client.query(`
        SELECT id, structured_fixes, field_values
        FROM decision_audit_records
        WHERE id = $1
        FOR UPDATE
      `, [recordId]);
      if (recordResult.rows.length === 0) {
        attempt.failure_reason = 'audit_record_not_found';
        return await finish(404, { error: 'audit_record_not_found' });
      }

      const row = recordResult.rows[0];
      const fixes = parseJsonArray(row.structured_fixes);
      const fix = fixes.find(item => item && item.fix_id === fixId);
      if (!fix) {
        attempt.failure_reason = 'fix_not_found';
        return await finish(404, { error: 'fix_not_found' });
      }

      if (!ALLOWED_FIELD_NAMES.has(fix.field_name) ||
          typeof fix.before_value !== 'string' ||
          typeof fix.after_value !== 'string') {
        attempt.field_name = boundedText(fix.field_name, 80);
        attempt.attempted_before = boundedText(fix.before_value);
        attempt.attempted_after = boundedText(fix.after_value);
        attempt.failure_reason = 'stored_fix_invalid';
        return await finish(500, { error: 'stored_fix_invalid' });
      }

      attempt.field_name = fix.field_name;
      attempt.attempted_before = boundedText(fix.before_value);
      attempt.attempted_after = boundedText(fix.after_value);

      const fieldValues = parseJsonObject(row.field_values);
      const hasStoredValue = Object.prototype.hasOwnProperty.call(fieldValues, fixId);
      const storedValue = hasStoredValue ? fieldValues[fixId] : null;
      attempt.observed_before = boundedText(storedValue);
      attempt.trigger_evaluated = true;
      attempt.trigger_matched = hasStoredValue && storedValue === fix.before_value;

      if (!attempt.trigger_matched) {
        attempt.precondition_failure_reason = 'stored_value_no_longer_matches_before_value';
        attempt.failure_reason = 'precondition_failed';
        return await finish(409, {
          error: 'precondition_failed',
          record_id: recordId,
          fix_id: fixId,
          field_name: fix.field_name,
          trigger_evaluated: true,
          trigger_matched: false,
          write_attempted: false,
          write_succeeded: false,
          verification_succeeded: false,
          failure_reason: attempt.failure_reason,
        });
      }

      attempt.write_attempted = true;
      const updateResult = await client.query(`
        UPDATE decision_audit_records
        SET field_values = jsonb_set(
              COALESCE(field_values, '{}'::jsonb),
              ARRAY[$2::text],
              to_jsonb($3::text),
              true
            ),
            updated_at = NOW()
        WHERE id = $1
        RETURNING id
      `, [recordId, fixId, fix.after_value]);
      attempt.write_succeeded = updateResult.rowCount === 1;

      if (attempt.write_succeeded) {
        const verificationResult = await client.query(`
          SELECT field_values ->> $2::text AS observed_after
          FROM decision_audit_records
          WHERE id = $1
        `, [recordId, fixId]);
        attempt.observed_after = boundedText(verificationResult.rows[0]?.observed_after);
        attempt.verification_succeeded = attempt.observed_after === fix.after_value;
      }

      if (!attempt.write_succeeded) {
        attempt.failure_reason = 'write_failed';
      } else if (!attempt.verification_succeeded) {
        attempt.failure_reason = 'read_after_write_mismatch';
      }

      const status = attempt.verification_succeeded ? 200 : 500;
      const payload = attempt.verification_succeeded
        ? {
            success: true,
            record_id: recordId,
            fix_id: fixId,
            field_name: fix.field_name,
            before_value: fix.before_value,
            after_value: fix.after_value,
            trigger_evaluated: true,
            trigger_matched: true,
            write_attempted: true,
            write_succeeded: true,
            verification_succeeded: true,
          }
        : {
            error: 'write_verification_failed',
            record_id: recordId,
            fix_id: fixId,
            field_name: fix.field_name,
            trigger_evaluated: true,
            trigger_matched: true,
            write_attempted: attempt.write_attempted,
            write_succeeded: attempt.write_succeeded,
            verification_succeeded: false,
            failure_reason: attempt.failure_reason,
          };

      return await finish(status, payload);
    } catch (error) {
      if (transactionOpen && client) {
        try {
          await client.query('ROLLBACK');
          transactionOpen = false;
        } catch (_) {}
      }

      attempt.http_status = 500;
      attempt.write_succeeded = false;
      attempt.verification_succeeded = false;
      attempt.observed_after = null;
      attempt.failure_reason = attempt.write_attempted
        ? 'database_write_error'
        : 'database_error';
      try {
        await insertAttempt(pool, attempt);
      } catch (logError) {
        console.error('[execution-apply-fix] failure log could not be persisted:', logError.message);
      }
      console.error('[execution-apply-fix] request failed:', error.message);
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'write_attempt_failed',
          precondition_failure_reason: attempt.precondition_failure_reason,
        });
      }
    } finally {
      if (client) client.release();
    }
  });

  return router;
}

module.exports = {
  ALLOWED_FIELD_NAMES,
  FIELD_PATTERNS,
  PATTERN_FIELDS,
  WRITE_SCOPE,
  WRITE_KEY_RATE_LIMIT,
  WRITE_KEY_RATE_WINDOW_SECONDS,
  attachStructuredFixes,
  createExecutionJsonErrorHandler,
  createDecisionExecutionRouter,
  createStructuredFixes,
  hashWriteKey,
  logUnparsedWriteAttempt,
  persistDecisionAuditRecord,
};