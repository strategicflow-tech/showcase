'use strict';

const crypto = require('node:crypto');

const PUBLIC_UPGRADE_URL = 'https://strategic-flow-pro.replit.app/decision-friction-review/';
const PUBLIC_REBUILD_MESSAGE = 'Full rebuild: locked, available in the paid Decision Friction Review ($149)';
const HIDDEN_PUBLIC_FIELDS = new Set([
  'after',
  'after_value',
  'rebuilt_subject',
  'rebuilt_body',
  'rebuilt_cta',
  'rebuilt_text',
  'new_cta',
  'variants',
  'cta_rewrite',
]);

function hasValidMcpInternalSecretValue(provided, expected) {
  if (typeof provided !== 'string' || !provided || typeof expected !== 'string' || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function removePublicRebuildFields(value) {
  if (Array.isArray(value)) return value.map(removePublicRebuildFields);
  if (!value || typeof value !== 'object') return value;

  const filtered = {};
  for (const [key, child] of Object.entries(value)) {
    if (HIDDEN_PUBLIC_FIELDS.has(key)) continue;
    filtered[key] = removePublicRebuildFields(child);
  }
  return filtered;
}

function buildMcpAuditResponse(payload, isInternalMcpCall) {
  if (isInternalMcpCall) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('MCP audit response must be an object');
  }

  const publicResponse = removePublicRebuildFields(payload);

  publicResponse.upgrade_url = PUBLIC_UPGRADE_URL;
  publicResponse.message = PUBLIC_REBUILD_MESSAGE;
  return publicResponse;
}

module.exports = {
  buildMcpAuditResponse,
  hasValidMcpInternalSecretValue,
};