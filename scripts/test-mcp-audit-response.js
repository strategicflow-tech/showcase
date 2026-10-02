'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMcpAuditResponse,
  hasValidMcpInternalSecretValue,
} = require('../mcp-audit-response');

const INTERNAL_SECRET = 'synthetic-internal-secret';
const HIDDEN_PUBLIC_FIELDS = [
  'after',
  'after_value',
  'rebuilt_subject',
  'rebuilt_body',
  'rebuilt_cta',
  'rebuilt_text',
  'new_cta',
  'variants',
  'cta_rewrite',
];

function makeFullAuditResponse() {
  return {
    original_score: 3.5,
    rebuilt_score: 8.5,
    original_subject: 'Monthly product update',
    rebuilt_subject: 'Recover missed renewals this month',
    rebuilt_body: ['A complete rewritten email body.'],
    rebuilt_cta: 'Fix my renewal gap',
    variants: [{ label: 'A', subject: 'Reduce missed renewals' }],
    cta_rewrite: {
      before: 'Learn more',
      after: 'Fix my renewal gap',
      nested: { after_value: 'Fix my renewal gap', new_cta: 'Fix my renewal gap' },
    },
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
      metadata: {
        preview: {
          after_value: 'Nested private rewrite',
          rebuilt_text: 'Nested private rewrite',
        },
      },
    }],
    private_preview: {
      nested: {
        rebuilt_text: 'A nested rebuilt draft',
        rebuilt_subject: 'A nested subject',
        rebuilt_body: ['A nested body'],
        rebuilt_cta: 'A nested CTA',
        variants: [{ subject: 'A nested variant' }],
        cta_rewrite: { after_value: 'A nested CTA' },
      },
    },
    audit_record_id: 'synthetic-audit-1',
    audits_used: 1,
    audits_remaining: 2,
    upgrade_url: null,
  };
}

function assertPublicRebuildIsHidden(response) {
  function visit(value, path = 'response') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value)) {
      assert.equal(HIDDEN_PUBLIC_FIELDS.includes(key), false, `${path}.${key} should be omitted`);
      visit(child, `${path}.${key}`);
    }
  }

  visit(response);
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
  assert.deepEqual(response.structured_fixes[0], {
    fix_id: 'synthetic-fix-1',
    pattern: 'Guest Language CTA',
    element: 'CTA',
    field_name: 'cta_text',
    before_value: 'Learn more',
    why: 'Ownership language makes the next step concrete.',
    metadata: { preview: {} },
  });
  assert.equal(response.original_subject, 'Monthly product update');
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
  assert.equal(storedAudit.cta_rewrite.nested.after_value, 'Fix my renewal gap');
});