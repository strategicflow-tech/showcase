'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROGRAM_URLS,
  buildEmail,
  createSomatizationMapWebhook
} = require('../somatization-map-delivery');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

function request(event) {
  return {
    body: Buffer.from('{}'),
    get(name) { return name === 'stripe-signature' ? 'valid-signature' : undefined; },
    event
  };
}

function paidEvent(overrides = {}) {
  return {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        payment_status: 'paid',
        metadata: { project: 'somatization-map', program: 'p1' },
        customer_details: { email: 'buyer@example.com' },
        ...overrides
      }
    }
  };
}

test('maps every supported program and includes four language blocks', () => {
  assert.deepEqual(Object.keys(PROGRAM_URLS), ['p1', 'p2', 'p3', 'p4', 'pack']);
  const email = buildEmail(PROGRAM_URLS.p1);
  assert.equal(email.subject, 'Your Somatization Map program');
  assert.match(email.text, /EN —/);
  assert.match(email.text, /RO —/);
  assert.match(email.text, /ES —/);
  assert.match(email.text, /FR —/);
  assert.equal((email.html.match(/<p>/g) || []).length, 4);
});

test('ignores other events and sessions outside the project without touching the database', async () => {
  let queryCount = 0;
  const service = createSomatizationMapWebhook({
    pool: { query: async () => { queryCount++; return { rows: [] }; } },
    resend: { emails: { send: async () => ({ data: { id: 're_1' } }) } },
    stripe: { webhooks: { constructEvent: () => ({ ...paidEvent(), type: 'charge.succeeded' }) } },
    env: { STRIPE_SOMATIZATION_WEBHOOK_SECRET: 'test-secret' },
    logger: { warn() {}, error() {} }
  });
  const res = responseRecorder();
  await service.handleWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(queryCount, 0);
});

test('records and sends one paid Somatization Map delivery', async () => {
  const queries = [];
  const sent = [];
  const event = paidEvent();
  const service = createSomatizationMapWebhook({
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return sql.includes('INSERT') ? { rows: [{ checkout_session_id: 'cs_test_1' }] } : { rows: [] };
      }
    },
    resend: { emails: { send: async params => { sent.push(params); return { data: { id: 're_test_1' } }; } } },
    stripe: { webhooks: { constructEvent: () => event } },
    env: { STRIPE_SOMATIZATION_WEBHOOK_SECRET: 'test-secret' },
    logger: { warn() {}, error() {} }
  });
  const res = responseRecorder();
  await service.handleWebhook(request(event), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'buyer@example.com');
  assert.match(sent[0].text, new RegExp(PROGRAM_URLS.p1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(sent[0]._skipGlobalEmailLog, true);
  assert.match(queries[0].sql, /ON CONFLICT \(checkout_session_id\) DO NOTHING/);
  assert.match(queries[1].sql, /resend_message_id/);
});

test('a repeated checkout session does not send another email', async () => {
  let sends = 0;
  const service = createSomatizationMapWebhook({
    pool: { query: async () => ({ rows: [] }) },
    resend: { emails: { send: async () => { sends++; return { data: { id: 're_test_1' } }; } } },
    stripe: { webhooks: { constructEvent: () => paidEvent() } },
    env: { STRIPE_SOMATIZATION_WEBHOOK_SECRET: 'test-secret' },
    logger: { warn() {}, error() {} }
  });
  const res = responseRecorder();
  await service.handleWebhook(request(), res);
  assert.equal(res.body.duplicate, true);
  assert.equal(sends, 0);
});

test('missing webhook secret returns 503 without verifying or sending', async () => {
  let verified = false;
  let sends = 0;
  const service = createSomatizationMapWebhook({
    pool: { query: async () => ({ rows: [] }) },
    resend: { emails: { send: async () => { sends++; } } },
    stripe: { webhooks: { constructEvent: () => { verified = true; } } },
    env: {},
    logger: { warn() {}, error() {} }
  });
  const res = responseRecorder();
  await service.handleWebhook(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(verified, false);
  assert.equal(sends, 0);
});

test('send failures are stored without logging the buyer email', async () => {
  const logs = [];
  const queries = [];
  const service = createSomatizationMapWebhook({
    pool: {
      query: async (sql) => {
        queries.push(sql);
        return sql.includes('INSERT') ? { rows: [{ checkout_session_id: 'cs_test_1' }] } : { rows: [] };
      }
    },
    resend: { emails: { send: async () => { throw new Error('provider error'); } } },
    stripe: { webhooks: { constructEvent: () => paidEvent() } },
    env: { STRIPE_SOMATIZATION_WEBHOOK_SECRET: 'test-secret' },
    logger: { warn: message => logs.push(message), error: message => logs.push(message) }
  });
  const res = responseRecorder();
  await service.handleWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.delivered, false);
  assert.match(queries[1], /status='failed'/);
  assert.ok(logs.every(message => !message.includes('buyer@example.com')));
});
