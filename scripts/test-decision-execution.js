'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { once } = require('node:events');
const test = require('node:test');

const {
  PATTERN_FIELDS,
  attachStructuredFixes,
  checkDemoRebuildHourlyLimit,
  createExecutionJsonErrorHandler,
  createDecisionExecutionRouter,
  hashWriteKey,
  isAllowlistedExecutionKey,
  resolveDemoRebuildHourlyCap,
  sendDemoRebuildHourlyDecision,
  WRITE_SCOPE,
} = require('../decision-execution-layer');

function makeDiagnosis() {
  return {
    rebuilt_cta: 'Fix my activation gap',
    changes: [
      { element: 'CTA', pattern: 'Guest Language CTA', before: 'Learn more', after: 'Fix my activation gap', why: 'Ownership makes the action concrete.' },
      { element: 'Lead', pattern: 'Feature-First Bias', before: 'New dashboard features', after: 'See what changed for your team', why: 'Lead with the reader outcome.' },
      { element: 'Subject', pattern: 'Filing Label Subject', before: 'June product update', after: 'Find missed renewals before month end', why: 'Name a reader consequence.' },
      { element: 'Opening', pattern: 'Consequence-After-Caveat', before: 'A few things changed', after: 'Recover the time spent reconciling reports', why: 'Put the consequence before the caveat.' },
      { element: 'Hierarchy', pattern: 'Missing Visual Hierarchy', before: 'All claims use equal weight', after: 'Give the primary outcome the strongest visual weight', why: 'Make the main decision visible first.' },
      { element: 'Proof', pattern: 'Zero/Buried Social Proof', before: '', after: 'Add the verified customer result near the claim', why: 'Put proof beside the claim it supports.' },
      { element: 'Urgency', pattern: 'Generic Urgency Theatre', before: 'Act now', after: 'Review the migration before the July 1 cutoff', why: 'Tie urgency to a real date.' },
    ],
  };
}

class FakePool {
  constructor() {
    this.state = {
      keys: [],
      records: new Map(),
      attempts: [],
      demoRebuildAttempts: [],
    };
    this.failDemoHourlyCountQuery = false;
  }

  async query(sql, params = []) {
    return this.execute(sql, params);
  }

  async connect() {
    return new FakeClient(this);
  }

  execute(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    if (normalized.startsWith('insert into execution_write_api_keys')) {
      const [id, keyHash, keyName, scope] = params;
      const row = {
        id,
        key_hash: keyHash,
        key_name: keyName,
        scope,
        created_at: new Date().toISOString(),
        revoked_at: null,
      };
      this.state.keys.push(row);
      return { rows: [{ id, key_name: keyName, scope, created_at: row.created_at }], rowCount: 1 };
    }

    if (normalized.startsWith('select k.id, k.key_name as name')) {
      const rows = this.state.keys
        .map(key => ({
          id: key.id,
          name: key.key_name,
          scope: key.scope,
          created_at: key.created_at,
          last_used_at: this.state.attempts
            .filter(attempt => attempt.write_key_id === key.id)
            .map(attempt => attempt.created_at)
            .sort()
            .at(-1) || null,
          revoked_at: key.revoked_at,
        }))
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith('update execution_write_api_keys')) {
      const [keyId] = params;
      const row = this.state.keys.find(key => key.id === keyId);
      if (!row) return { rows: [], rowCount: 0 };
      row.revoked_at ||= new Date().toISOString();
      return {
        rows: [{
          id: row.id,
          name: row.key_name,
          scope: row.scope,
          created_at: row.created_at,
          revoked_at: row.revoked_at,
        }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith('select id, scope, revoked_at from execution_write_api_keys')) {
      const [keyHash] = params;
      const row = this.state.keys.find(key => key.key_hash === keyHash);
      return {
        rows: row ? [{ id: row.id, scope: row.scope, revoked_at: row.revoked_at }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (normalized.startsWith('select id, revoked_at from execution_write_api_keys')) {
      const [keyHash] = params;
      const row = this.state.keys.find(key => key.key_hash === keyHash);
      return {
        rows: row ? [{ id: row.id, revoked_at: row.revoked_at }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (normalized.startsWith('select count(*)::int as call_count') &&
        normalized.includes('from decision_execution_attempts')) {
      const [keyId] = params;
      const cutoff = Date.now() - 60 * 60 * 1000;
      const recent = this.state.attempts.filter(attempt =>
        attempt.write_key_id === keyId &&
        attempt.failure_reason !== 'rate_limited' &&
        new Date(attempt.created_at).getTime() >= cutoff
      );
      const oldest = recent
        .map(attempt => new Date(attempt.created_at).getTime())
        .sort((left, right) => left - right)[0];
      const retryAfterSeconds = oldest
        ? Math.max(0, Math.ceil((oldest + 60 * 60 * 1000 - Date.now()) / 1000))
        : 0;
      return {
        rows: [{ call_count: recent.length, retry_after_seconds: retryAfterSeconds }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith('select count(*)::int as call_count, coalesce(')) {
      if (this.failDemoHourlyCountQuery) throw new Error('simulated hourly counter database failure');
      const [keyId] = params;
      const cutoff = Date.now() - 60 * 60 * 1000;
      const recent = this.state.demoRebuildAttempts.filter(attempt =>
        attempt.write_key_id === keyId &&
        new Date(attempt.created_at).getTime() >= cutoff
      );
      const oldest = recent
        .map(attempt => new Date(attempt.created_at).getTime())
        .sort((left, right) => left - right)[0];
      const retryAfterSeconds = oldest
        ? Math.max(1, Math.ceil((oldest + 60 * 60 * 1000 - Date.now()) / 1000))
        : 1;
      return {
        rows: [{ call_count: recent.length, retry_after_seconds: retryAfterSeconds }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith('select pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith('insert into demo_rebuild_allowlisted_attempts')) {
      const [keyId] = params;
      this.state.demoRebuildAttempts.push({
        write_key_id: keyId,
        created_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('select structured_fixes, field_values from decision_audit_records')) {
      const [recordId] = params;
      const row = this.state.records.get(recordId);
      return { rows: row ? [{ structured_fixes: row.structured_fixes, field_values: row.field_values }] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('select id, updated_at, structured_fixes, field_values from decision_audit_records')) {
      const [recordId] = params;
      const row = this.state.records.get(recordId);
      return {
        rows: row ? [{
          id: row.id,
          updated_at: row.updated_at,
          structured_fixes: row.structured_fixes,
          field_values: row.field_values,
        }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (normalized.startsWith('select id, structured_fixes, field_values from decision_audit_records')) {
      const [recordId] = params;
      const row = this.state.records.get(recordId);
      return { rows: row ? [{ id: row.id, structured_fixes: row.structured_fixes, field_values: row.field_values }] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('update decision_audit_records')) {
      const [recordId, fixId, afterValue] = params;
      const row = this.state.records.get(recordId);
      if (!row) return { rows: [], rowCount: 0 };
      row.field_values[fixId] = afterValue;
      row.updated_at = new Date(Date.now() + 1).toISOString();
      return { rows: [{ id: recordId }], rowCount: 1 };
    }

    if (normalized.startsWith('select field_values ->>')) {
      const [recordId, fixId] = params;
      const row = this.state.records.get(recordId);
      const observedAfter = row ? row.field_values[fixId] : null;
      return { rows: row ? [{ observed_after: observedAfter ?? null }] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('insert into decision_execution_attempts')) {
      const [
        requestId, recordId, fixId, fieldName, attemptedBefore, attemptedAfter,
        observedBefore, observedAfter, triggerEvaluated, triggerMatched,
        preconditionFailureReason, writeAttempted, writeSucceeded,
        verificationSucceeded, failureReason, httpStatus, writeKeyId,
      ] = params;
      this.state.attempts.push({
        request_id: requestId,
        record_id: recordId,
        fix_id: fixId,
        field_name: fieldName,
        attempted_before: attemptedBefore,
        attempted_after: attemptedAfter,
        observed_before: observedBefore,
        observed_after: observedAfter,
        trigger_evaluated: triggerEvaluated,
        trigger_matched: triggerMatched,
        precondition_failure_reason: preconditionFailureReason,
        write_attempted: writeAttempted,
        write_succeeded: writeSucceeded,
        verification_succeeded: verificationSucceeded,
        failure_reason: failureReason,
        http_status: httpStatus,
        write_key_id: writeKeyId,
        created_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake SQL: ${normalized}`);
  }
}

class FakeClient {
  constructor(pool) {
    this.pool = pool;
    this.snapshot = null;
  }

  async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'begin') {
      this.snapshot = structuredClone(this.pool.state);
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'commit') {
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'rollback') {
      if (this.snapshot) this.pool.state = this.snapshot;
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    return this.pool.execute(sql, params);
  }

  release() {}
}

async function startTestServer(pool, adminKey = 'admin-issuer-secret') {
  const app = express();
  app.use(express.json());
  app.use(createExecutionJsonErrorHandler({ pool }));
  app.use(createDecisionExecutionRouter({ pool, adminKey }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function seedExecutionKey(pool, apiKey = `sf_exec_test_${crypto.randomBytes(12).toString('hex')}`, revokedAt = null) {
  const keyId = crypto.randomUUID();
  pool.state.keys.push({
    id: keyId,
    key_hash: hashWriteKey(apiKey),
    key_name: 'Execution test key',
    scope: WRITE_SCOPE,
    created_at: new Date().toISOString(),
    revoked_at: revokedAt,
  });
  return { apiKey, keyId };
}

test('demo rebuild allowlist matches only valid, non-revoked bearer key IDs', async () => {
  const pool = new FakePool();
  const { apiKey, keyId } = seedExecutionKey(pool);
  const request = authorization => ({
    get(name) {
      return name.toLowerCase() === 'authorization' ? authorization : undefined;
    },
  });

  assert.equal(await isAllowlistedExecutionKey(pool, request(undefined), new Set([keyId])), false);
  assert.equal(await isAllowlistedExecutionKey(pool, request('Bearer invalid-key'), new Set([keyId])), false);
  assert.equal(await isAllowlistedExecutionKey(pool, request(`Bearer ${apiKey}`), new Set()), false);
  assert.equal(await isAllowlistedExecutionKey(pool, request(`Bearer ${apiKey}`), new Set([keyId.toLowerCase()])), true);
  assert.equal(await isAllowlistedExecutionKey(pool, request(`Bearer ${apiKey}`), new Set([crypto.randomUUID()])), false);

  const revoked = seedExecutionKey(pool, undefined, new Date().toISOString());
  assert.equal(
    await isAllowlistedExecutionKey(pool, request(`Bearer ${revoked.apiKey}`), new Set([revoked.keyId])),
    false
  );
});

test('allowlisted demo rebuild hourly cap defaults to 10 and returns 429 with Retry-After at the cap', async () => {
  assert.equal(resolveDemoRebuildHourlyCap(undefined), 10);
  assert.equal(resolveDemoRebuildHourlyCap(''), 10);
  assert.equal(resolveDemoRebuildHourlyCap('3'), 3);

  const pool = new FakePool();
  const { apiKey, keyId } = seedExecutionKey(pool);
  const request = { get: name => name.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : undefined };
  const allowlist = new Set([keyId]);

  const first = await checkDemoRebuildHourlyLimit(pool, request, allowlist, '2');
  const second = await checkDemoRebuildHourlyLimit(pool, request, allowlist, '2');
  assert.equal(first.allowlisted, true);
  assert.equal(second.allowlisted, true);
  assert.equal(pool.state.demoRebuildAttempts.length, 2);

  const limited = await checkDemoRebuildHourlyLimit(pool, request, allowlist, '2');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'hourly_limit_reached');
  assert.equal(limited.body.limit, 2);
  assert.ok(limited.retryAfterSeconds >= 1);
  assert.equal(pool.state.demoRebuildAttempts.length, 2);

  const headers = {};
  let status;
  let body;
  const response = {
    set(name, value) { headers[name] = value; return this; },
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  assert.equal(sendDemoRebuildHourlyDecision(response, limited), true);
  assert.equal(status, 429);
  assert.equal(headers['Retry-After'], String(limited.retryAfterSeconds));
  assert.equal(body.error, 'hourly_limit_reached');
});

test('allowlisted hourly cap is isolated by execution key ID', async () => {
  const pool = new FakePool();
  const firstKey = seedExecutionKey(pool);
  const secondKey = seedExecutionKey(pool);
  const allowlist = new Set([firstKey.keyId, secondKey.keyId]);
  const requestFor = apiKey => ({
    get(name) { return name.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : undefined; },
  });

  assert.equal((await checkDemoRebuildHourlyLimit(pool, requestFor(firstKey.apiKey), allowlist, 1)).allowlisted, true);
  assert.equal((await checkDemoRebuildHourlyLimit(pool, requestFor(firstKey.apiKey), allowlist, 1)).status, 429);
  const secondKeyDecision = await checkDemoRebuildHourlyLimit(pool, requestFor(secondKey.apiKey), allowlist, 1);
  assert.equal(secondKeyDecision.allowlisted, true);
  assert.equal(secondKeyDecision.status, undefined);
  assert.equal(pool.state.demoRebuildAttempts.length, 2);
});

test('non-allowlisted execution keys keep the existing per-text path without hourly reservations', async () => {
  const pool = new FakePool();
  const { apiKey } = seedExecutionKey(pool);
  const request = { get: name => name.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : undefined };
  const decision = await checkDemoRebuildHourlyLimit(pool, request, new Set([crypto.randomUUID()]), 1);

  assert.equal(decision.allowlisted, false);
  assert.equal(decision.keyId, null);
  assert.equal(decision.status, undefined);
  assert.equal(pool.state.demoRebuildAttempts.length, 0);
});

test('hourly limiter database failures fail closed with 503 and no reservation', async () => {
  const pool = new FakePool();
  pool.failDemoHourlyCountQuery = true;
  const { apiKey, keyId } = seedExecutionKey(pool);
  const request = { get: name => name.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : undefined };
  const decision = await checkDemoRebuildHourlyLimit(pool, request, new Set([keyId]), 10);

  assert.equal(decision.allowlisted, true);
  assert.equal(decision.status, 503);
  assert.equal(decision.body.error, 'hourly_limit_unavailable');
  assert.equal(pool.state.demoRebuildAttempts.length, 0);

  let status;
  let body;
  const response = {
    set() { return this; },
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  assert.equal(sendDemoRebuildHourlyDecision(response, decision), true);
  assert.equal(status, 503);
  assert.equal(body.error, 'hourly_limit_unavailable');
});

function seedAuditRecord(pool) {
  const diagnosis = attachStructuredFixes(makeDiagnosis());
  const recordId = crypto.randomUUID();
  const fieldValues = Object.fromEntries(
    diagnosis.structured_fixes.map(fix => [fix.fix_id, fix.before_value])
  );
  const record = {
    id: recordId,
    structured_fixes: diagnosis.structured_fixes,
    field_values: fieldValues,
    updated_at: new Date(Date.now() - 1000).toISOString(),
  };
  pool.state.records.set(recordId, record);
  return {
    diagnosis,
    recordId,
    record,
    fix: diagnosis.structured_fixes.find(fix => fix.field_name === 'cta_text'),
  };
}

test('every named DFM pattern becomes a structured fix and retains the legacy CTA string', () => {
  const diagnosis = makeDiagnosis();
  let sequence = 1;
  const enriched = attachStructuredFixes(diagnosis, {
    idFactory: () => `fx_${String(sequence++).padStart(10, '0')}`,
  });

  assert.equal(enriched.rebuilt_cta, 'Fix my activation gap');
  assert.equal(enriched.structured_fixes.length, 7);
  assert.deepEqual(
    enriched.structured_fixes.map(fix => fix.field_name),
    Object.values(PATTERN_FIELDS)
  );
  assert.equal(enriched.cta_rewrite.field_name, 'cta_text');
  assert.equal(enriched.cta_rewrite.before_value, 'Learn more');
  assert.equal(enriched.cta_rewrite.after_value, enriched.rebuilt_cta);
  assert.match(enriched.cta_rewrite.fix_id, /^fx_[a-f0-9]{10}$/);
  assert.equal(enriched.structured_fixes.find(fix => fix.field_name === 'social_proof').before_value, '');
});

test('admin-issued key is separate, successful writes verify, and failed triggers are logged', async t => {
  const pool = new FakePool();
  const { server, baseUrl } = await startTestServer(pool);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const diagnosis = attachStructuredFixes(makeDiagnosis());
  const recordId = crypto.randomUUID();
  const fieldValues = Object.fromEntries(
    diagnosis.structured_fixes.map(fix => [fix.fix_id, fix.before_value])
  );
  pool.state.records.set(recordId, {
    id: recordId,
    structured_fixes: diagnosis.structured_fixes,
    field_values: fieldValues,
    updated_at: new Date(Date.now() - 1000).toISOString(),
  });

  const issueDenied = await fetch(`${baseUrl}/api/admin/execution-write-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'POC key' }),
  });
  assert.equal(issueDenied.status, 401);

  const issueResponse = await fetch(`${baseUrl}/api/admin/execution-write-keys`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-key': 'admin-issuer-secret',
    },
    body: JSON.stringify({ name: 'Execution POC' }),
  });
  assert.equal(issueResponse.status, 201);
  const issued = await issueResponse.json();
  assert.equal(issued.scope, 'decision_audit.write');
  assert.equal(issued.key_returned_once, true);
  assert.notEqual(pool.state.keys[0].key_hash, issued.api_key);
  assert.equal(pool.state.keys[0].key_hash, hashWriteKey(issued.api_key));

  const malformedResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformedResponse.status, 400);
  assert.equal(pool.state.attempts.at(-1).failure_reason, 'invalid_json');
  assert.equal(pool.state.attempts.at(-1).http_status, 400);

  const ctaFix = diagnosis.structured_fixes.find(fix => fix.field_name === 'cta_text');
  const unauthorizedResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer legacy-audit-email-key',
    },
    body: JSON.stringify({ record_id: recordId, fix_id: ctaFix.fix_id }),
  });
  assert.equal(unauthorizedResponse.status, 401);
  assert.equal(pool.state.records.get(recordId).field_values[ctaFix.fix_id], 'Learn more');
  assert.equal(pool.state.attempts.at(-1).failure_reason, 'invalid_api_key');
  assert.equal(pool.state.attempts.at(-1).field_name, 'cta_text');
  assert.equal(pool.state.attempts.at(-1).attempted_after, 'Fix my activation gap');
  assert.equal(pool.state.attempts.at(-1).write_attempted, false);

  const successResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${issued.api_key}`,
    },
    body: JSON.stringify({ record_id: recordId, fix_id: ctaFix.fix_id }),
  });
  assert.equal(successResponse.status, 200);
  const success = await successResponse.json();
  assert.equal(success.success, true);
  assert.equal(success.field_name, 'cta_text');
  assert.equal(success.write_succeeded, true);
  assert.equal(success.verification_succeeded, true);
  assert.equal(pool.state.records.get(recordId).field_values[ctaFix.fix_id], ctaFix.after_value);
  assert.equal(pool.state.attempts.at(-1).trigger_evaluated, true);
  assert.equal(pool.state.attempts.at(-1).trigger_matched, true);
  assert.equal(pool.state.attempts.at(-1).write_attempted, true);
  assert.equal(pool.state.attempts.at(-1).verification_succeeded, true);

  const staleResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${issued.api_key}`,
    },
    body: JSON.stringify({ record_id: recordId, fix_id: ctaFix.fix_id }),
  });
  assert.equal(staleResponse.status, 409);
  const stale = await staleResponse.json();
  assert.equal(stale.error, 'precondition_failed');
  assert.equal(stale.precondition_failure_reason, 'stored_value_no_longer_matches_before_value');
  assert.equal(pool.state.attempts.at(-1).trigger_evaluated, true);
  assert.equal(pool.state.attempts.at(-1).trigger_matched, false);
  assert.equal(pool.state.attempts.at(-1).precondition_failure_reason, 'stored_value_no_longer_matches_before_value');
  assert.equal(pool.state.attempts.at(-1).write_attempted, false);
  assert.equal(pool.state.attempts.at(-1).write_succeeded, false);
  assert.equal(pool.state.attempts.at(-2).write_key_id, issued.key_id);

  const listResponse = await fetch(`${baseUrl}/api/admin/execution-write-keys`, {
    headers: { 'x-admin-key': 'admin-issuer-secret' },
  });
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.keys.length, 1);
  const listedKey = listPayload.keys[0];
  assert.equal(listedKey.id, issued.key_id);
  assert.equal(listedKey.name, 'Execution POC');
  assert.equal(listedKey.scope, WRITE_SCOPE);
  assert.ok(listedKey.created_at);
  assert.ok(listedKey.last_used_at);
  assert.equal(listedKey.revoked_at, null);
  assert.equal(Object.hasOwn(listedKey, 'api_key'), false);
  assert.equal(Object.hasOwn(listedKey, 'key_hash'), false);
  assert.equal(JSON.stringify(listPayload).includes(issued.api_key), false);

  const revokeResponse = await fetch(
    `${baseUrl}/api/admin/execution-write-keys/${issued.key_id}/revoke`,
    {
      method: 'POST',
      headers: { 'x-admin-key': 'admin-issuer-secret' },
    }
  );
  assert.equal(revokeResponse.status, 200);
  const revokePayload = await revokeResponse.json();
  assert.equal(revokePayload.success, true);
  assert.equal(revokePayload.key.id, issued.key_id);
  assert.ok(revokePayload.key.revoked_at);

  const revokedKeyResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${issued.api_key}`,
    },
    body: JSON.stringify({ record_id: recordId, fix_id: ctaFix.fix_id }),
  });
  assert.equal(revokedKeyResponse.status, 401);
  assert.equal(pool.state.attempts.at(-1).write_key_id, issued.key_id);
  assert.equal(pool.state.attempts.at(-1).failure_reason, 'invalid_api_key');

  const relisted = await (await fetch(`${baseUrl}/api/admin/execution-write-keys`, {
    headers: { 'x-admin-key': 'admin-issuer-secret' },
  })).json();
  assert.ok(relisted.keys[0].revoked_at);
  assert.equal(pool.state.attempts.length, 5);
});

test('record reads are read-only and reflect apply, restore, and re-apply', async t => {
  const pool = new FakePool();
  const { server, baseUrl } = await startTestServer(pool);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { apiKey } = seedExecutionKey(pool);
  const { recordId, record, fix } = seedAuditRecord(pool);
  const initialUpdatedAt = record.updated_at;
  const headers = { authorization: `Bearer ${apiKey}` };

  const initialReadResponse = await fetch(`${baseUrl}/api/execution/records/${recordId}`, { headers });
  assert.equal(initialReadResponse.status, 200);
  const initialRead = await initialReadResponse.json();
  assert.deepEqual(Object.keys(initialRead).sort(), ['fixes', 'record_id', 'updated_at']);
  assert.equal(initialRead.record_id, recordId);
  assert.equal(initialRead.updated_at, initialUpdatedAt);
  assert.deepEqual(initialRead.fixes.find(item => item.fix_id === fix.fix_id), {
    fix_id: fix.fix_id,
    field_name: 'cta_text',
    before_value: fix.before_value,
    after_value: fix.after_value,
    current_value: fix.before_value,
  });
  assert.equal(Object.hasOwn(initialRead, 'diagnosis'), false);
  assert.equal(pool.state.attempts.length, 0);
  assert.equal(record.updated_at, initialUpdatedAt);

  const applyResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
  });
  assert.equal(applyResponse.status, 200);
  const appliedUpdatedAt = record.updated_at;

  const appliedReadResponse = await fetch(`${baseUrl}/api/execution/records/${recordId}`, { headers });
  assert.equal(appliedReadResponse.status, 200);
  const appliedRead = await appliedReadResponse.json();
  assert.equal(appliedRead.fixes.find(item => item.fix_id === fix.fix_id).current_value, fix.after_value);
  assert.equal(appliedRead.updated_at, appliedUpdatedAt);
  assert.equal(pool.state.attempts.length, 1);
  assert.equal(record.updated_at, appliedUpdatedAt);

  const restoreResponse = await fetch(`${baseUrl}/api/execution/restore-fix`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
  });
  assert.equal(restoreResponse.status, 200);
  const restored = await restoreResponse.json();
  assert.equal(restored.success, true);
  assert.equal(restored.record_id, recordId);
  assert.equal(restored.fix_id, fix.fix_id);
  assert.equal(restored.field_name, 'cta_text');
  assert.equal(restored.restored_value, fix.before_value);
  assert.equal(restored.previous_value, fix.after_value);
  assert.equal(restored.write_attempted, true);
  assert.equal(restored.write_succeeded, true);
  assert.equal(restored.verification_succeeded, true);
  assert.equal(pool.state.attempts.at(-1).failure_reason, null);
  assert.equal(pool.state.attempts.at(-1).attempted_before, fix.after_value);
  assert.equal(pool.state.attempts.at(-1).attempted_after, fix.before_value);

  const restoredUpdatedAt = record.updated_at;
  const restoredReadResponse = await fetch(`${baseUrl}/api/execution/records/${recordId}`, { headers });
  assert.equal(restoredReadResponse.status, 200);
  const restoredRead = await restoredReadResponse.json();
  assert.equal(restoredRead.fixes.find(item => item.fix_id === fix.fix_id).current_value, fix.before_value);
  assert.equal(restoredRead.updated_at, restoredUpdatedAt);
  assert.equal(pool.state.attempts.length, 2);
  assert.equal(record.updated_at, restoredUpdatedAt);

  const reapplyResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
  });
  assert.equal(reapplyResponse.status, 200);
  assert.equal(record.field_values[fix.fix_id], fix.after_value);
});

test('record read and restore validate ids and missing records', async t => {
  const pool = new FakePool();
  const { server, baseUrl } = await startTestServer(pool);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { apiKey } = seedExecutionKey(pool);
  const { fix } = seedAuditRecord(pool);
  const headers = { authorization: `Bearer ${apiKey}` };

  const invalidRead = await fetch(`${baseUrl}/api/execution/records/not-a-uuid`, { headers });
  assert.equal(invalidRead.status, 400);
  assert.equal((await invalidRead.json()).error, 'invalid_record_id');

  const missingRecordId = crypto.randomUUID();
  const missingRead = await fetch(`${baseUrl}/api/execution/records/${missingRecordId}`, { headers });
  assert.equal(missingRead.status, 404);
  assert.equal((await missingRead.json()).error, 'audit_record_not_found');

  const invalidRestore = await fetch(`${baseUrl}/api/execution/restore-fix`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ record_id: 'not-a-uuid', fix_id: fix.fix_id }),
  });
  assert.equal(invalidRestore.status, 400);
  assert.equal((await invalidRestore.json()).error, 'invalid_record_or_fix_id');

  const missingRestore = await fetch(`${baseUrl}/api/execution/restore-fix`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ record_id: missingRecordId, fix_id: fix.fix_id }),
  });
  assert.equal(missingRestore.status, 404);
  assert.equal((await missingRestore.json()).error, 'audit_record_not_found');
});

test('restore returns 409 when the fix is not currently applied', async t => {
  const pool = new FakePool();
  const { server, baseUrl } = await startTestServer(pool);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { apiKey } = seedExecutionKey(pool);
  const { recordId, record, fix } = seedAuditRecord(pool);
  const originalUpdatedAt = record.updated_at;

  const response = await fetch(`${baseUrl}/api/execution/restore-fix`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
  });
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.error, 'not_applied');
  assert.equal(result.precondition_failure_reason, 'not_applied');
  assert.equal(record.field_values[fix.fix_id], fix.before_value);
  assert.equal(record.updated_at, originalUpdatedAt);
  assert.equal(pool.state.attempts.at(-1).failure_reason, 'not_applied');
  assert.equal(pool.state.attempts.at(-1).write_attempted, false);
});

test('record read and restore reject revoked execution keys', async t => {
  const pool = new FakePool();
  const { server, baseUrl } = await startTestServer(pool);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const revokedAt = new Date().toISOString();
  const { apiKey, keyId } = seedExecutionKey(pool, undefined, revokedAt);
  const { recordId, fix } = seedAuditRecord(pool);
  const headers = { authorization: `Bearer ${apiKey}` };

  const readResponse = await fetch(`${baseUrl}/api/execution/records/${recordId}`, { headers });
  assert.equal(readResponse.status, 401);
  assert.equal((await readResponse.json()).error, 'unauthorized');
  assert.equal(pool.state.attempts.length, 0);

  const restoreResponse = await fetch(`${baseUrl}/api/execution/restore-fix`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
  });
  assert.equal(restoreResponse.status, 401);
  assert.equal((await restoreResponse.json()).error, 'unauthorized');
  assert.equal(pool.state.attempts.at(-1).write_key_id, keyId);
  assert.equal(pool.state.attempts.at(-1).failure_reason, 'invalid_api_key');
});

test('restore uses the same per-key rate limit and 429 response as apply-fix', async t => {
  const pool = new FakePool();
  const { server, baseUrl } = await startTestServer(pool);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { apiKey } = seedExecutionKey(pool);
  const { recordId, fix } = seedAuditRecord(pool);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };

  const applyResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
  });
  assert.equal(applyResponse.status, 200);

  for (let call = 0; call < 58; call += 1) {
    const response = await fetch(`${baseUrl}/api/execution/apply-fix`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
    });
    assert.equal(response.status, 409);
  }

  const restoreResponse = await fetch(`${baseUrl}/api/execution/restore-fix`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
  });
  assert.equal(restoreResponse.status, 200);

  const limitedApplyResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ record_id: recordId, fix_id: fix.fix_id }),
  });
  assert.equal(limitedApplyResponse.status, 429);
  const limited = await limitedApplyResponse.json();
  assert.equal(limited.error, 'rate_limited');
  assert.equal(limited.limit, 60);
  assert.equal(limited.window_seconds, 3600);
  assert.ok(limited.retry_after_seconds >= 1);
  assert.equal(limitedApplyResponse.headers.get('retry-after'), String(limited.retry_after_seconds));
});

test('a write-scoped key is limited to 60 calls in a rolling hour', async t => {
  const pool = new FakePool();
  const { server, baseUrl } = await startTestServer(pool);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const apiKey = `sf_exec_test_${crypto.randomBytes(8).toString('hex')}`;
  const keyId = crypto.randomUUID();
  pool.state.keys.push({
    id: keyId,
    key_hash: hashWriteKey(apiKey),
    key_name: 'Rate limit test',
    scope: WRITE_SCOPE,
    created_at: new Date().toISOString(),
    revoked_at: null,
  });

  const diagnosis = attachStructuredFixes(makeDiagnosis());
  const recordId = crypto.randomUUID();
  const fieldValues = Object.fromEntries(
    diagnosis.structured_fixes.map(fix => [fix.fix_id, fix.before_value])
  );
  pool.state.records.set(recordId, {
    id: recordId,
    structured_fixes: diagnosis.structured_fixes,
    field_values: fieldValues,
    updated_at: new Date(Date.now() - 1000).toISOString(),
  });
  const fixId = diagnosis.structured_fixes.find(fix => fix.field_name === 'cta_text').fix_id;

  for (let call = 0; call < 60; call += 1) {
    const response = await fetch(`${baseUrl}/api/execution/apply-fix`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ record_id: recordId, fix_id: fixId }),
    });
    assert.ok([200, 409].includes(response.status), `call ${call + 1} should be within the limit`);
  }

  const limitedResponse = await fetch(`${baseUrl}/api/execution/apply-fix`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ record_id: recordId, fix_id: fixId }),
  });
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get('retry-after') !== null, true);
  const limited = await limitedResponse.json();
  assert.equal(limited.error, 'rate_limited');
  assert.equal(limited.limit, 60);
  assert.equal(limited.window_seconds, 3600);
  assert.ok(limited.retry_after_seconds >= 1);
  assert.equal(pool.state.attempts.at(-1).failure_reason, 'rate_limited');
  assert.equal(pool.state.attempts.at(-1).write_key_id, keyId);
  assert.equal(pool.state.attempts.length, 61);
});