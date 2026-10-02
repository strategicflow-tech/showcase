'use strict';

const crypto = require('node:crypto');

const PUBLIC_UPGRADE_URL = 'https://strategic-flow-pro.replit.app/decision-friction-review/';
const PUBLIC_REBUILD_MESSAGE = 'Full rebuild: locked, available in the paid Decision Friction Review ($149)';
const HIDDEN_REBUILD_FIELDS = ['rebuilt_subject', 'rebuilt_body', 'rebuilt_cta', 'variants'];
const FIX_ARRAY_FIELDS = ['changes', 'structured_fixes'];

function hasValidMcpInternalSecretValue(provided, expected) {
  if (typeof provided !== 'string' || !provided || typeof expected !== 'string' || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function buildMcpAuditResponse(payload, isInternalMcpCall) {
  if (isInternalMcpCall) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('MCP audit response must be an object');
  }

  const publicResponse = { ...payload };
  for (const field of HIDDEN_REBUILD_FIELDS) {
    delete publicResponse[field];
  }

  for (const field of FIX_ARRAY_FIELDS) {
    if (!Array.isArray(publicResponse[field])) continue;
    publicResponse[field] = publicResponse[field].map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const safeItem = { ...item };
      delete safeItem.after;
      delete safeItem.after_value;
      return safeItem;
    });
  }

  publicResponse.upgrade_url = PUBLIC_UPGRADE_URL;
  publicResponse.message = PUBLIC_REBUILD_MESSAGE;
  return publicResponse;
}

module.exports = {
  buildMcpAuditResponse,
  hasValidMcpInternalSecretValue,
};