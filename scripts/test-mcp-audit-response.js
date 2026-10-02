'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMcpAuditResponse,
  hasValidMcpInternalSecretValue,
} = require('../mcp-audit-response');

const INTERNAL_SECRET = 'synthetic-internal-secret';

function makeFullAuditResponse() {
  return {
    original_score: 3.5,
    rebuilt_score: 8.5,
    rebuilt_subject: 'Recover missed renewals this month',
    rebuilt_body: ['A complete rewritten email body.'],
    rebuilt_cta: 'Fix my renewal gap',
    variants: [{ label: 'A', subject: 'Reduce missed renewals' }],
    changes: [{
      element: 'Subject',
      pattern: 'Filing Label Subject',
      field_name: 'subject_line',
      before: 'Monthly product update',
      after: 'Recover missed renewals this month',
      why: 'The revised subject makes the reader outcome explicit.',
    }],
    structured_fixes: [{
      fix_id: 'synthetic-fix-1',
      pattern: 'Guest Language CTA',
      element: 'CTA',
      field_name: 'cta_text',
      before_value: 'Learn more',
      after_value: 'Fix my renewal gap',
      after: 'Fix my renewal gap',
      why: 'Ownership language makes the next step concrete.',
    }],
    audit_record_id: 'synthetic-audit-1',
    audits_used: 1,
    audits_remaining: 2,
    upgrade_url: null,
  };
}

function assertPublicRebuildIsHidden(response) {
  for (const field of ['rebuilt_subject', 'rebuilt_body', 'rebuilt_cta', 'variants']) {
    assert.equal(Object.hasOwn(response, field), false, `${field} should be omitted`);
  }
  for (const field of ['changes', 'structured_fixes']) {
    for (const fix of response[field]) {
      assert.equal(Object.hasOwn(fix, 'after'), false, `${field}.after should be omitted`);
      assert.equal(Object.hasOwn(fix, 'after_value'), false, `${field}.after_value should be omitted`);
    }
  }
  assert.equal(response.upgrade_url, 'https://strategic-flow-pro.replit.app/decision-friction-review/');
  assert.equal(
    response.message,
    'Full rebuild: locked, available in the paid Decision Friction Review ($149)'
  );
}

test('public audit response removes full rebuild content and preserves diagnosis fields', () => {
  const fullResponse = makeFullAuditResponse();
  const response = buildMcpAuditResponse(fullResponse, false);

  assertPublicRebuildIsHidden(response);
  assert.equal(response.audit_record_id, 'synthetic-audit-1');
  assert.deepEqual(response.changes[0], {
    element: 'Subject',
    pattern: 'Filing Label Subject',
    field_name: 'subject_line',
    before: 'Monthly product update',
    why: 'The revised subject makes the reader outcome explicit.',
  });
  assert.equal(response.structured_fixes[0].before_value, 'Learn more');
  assert.equal(response.structured_fixes[0].pattern, 'Guest Language CTA');
  assert.equal(response.original_score, 3.5);
  assert.equal(response.rebuilt_score, 8.5);
});

test('a valid internal secret keeps the complete audit response', () => {
  const fullResponse = makeFullAuditResponse();
  assert.equal(hasValidMcpInternalSecretValue(INTERNAL_SECRET, INTERNAL_SECRET), true);
  assert.deepEqual(
    buildMcpAuditResponse(fullResponse, hasValidMcpInternalSecretValue(INTERNAL_SECRET, INTERNAL_SECRET)),
    fullResponse
  );
});

test('an incorrect internal secret is treated as public and cannot access rebuild fields', () => {
  const fullResponse = makeFullAuditResponse();
  const isInternal = hasValidMcpInternalSecretValue('wrong-synthetic-secret', INTERNAL_SECRET);

  assert.equal(isInternal, false);
  assertPublicRebuildIsHidden(buildMcpAuditResponse(fullResponse, isInternal));
});

test('public response filtering does not mutate the complete stored audit fixture', () => {
  const storedAudit = makeFullAuditResponse();
  const originalStoredAudit = structuredClone(storedAudit);

  buildMcpAuditResponse(storedAudit, false);

  assert.deepEqual(storedAudit, originalStoredAudit);
  assert.equal(storedAudit.structured_fixes[0].after_value, 'Fix my renewal gap');
  assert.equal(storedAudit.changes[0].after, 'Recover missed renewals this month');
});