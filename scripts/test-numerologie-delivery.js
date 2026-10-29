'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { packForPaymentLink, emailLanguage, buildEmail, PACKS, createNumerologieDeliveryService } = require('../numerologie-delivery');

test('maps only the four exact Stripe payment links', () => {
  assert.equal(packForPaymentLink('plink_1UVy37DpTwoDeZJnPhVDbxGW').key, 'numdeep');
  assert.equal(packForPaymentLink('plink_1UVy38DpTwoDeZJnnWdw2gCL').key, 'nlpdeep');
  assert.equal(packForPaymentLink('plink_1UVy38DpTwoDeZJnWJLPKySP').key, 'crosspro');
  assert.equal(packForPaymentLink('plink_1UVy39DpTwoDeZJnAJ7b59UP').key, 'bundle');
  assert.equal(packForPaymentLink('plink_other'), null);
  assert.equal(packForPaymentLink({ id: 'plink_1UVy37DpTwoDeZJnPhVDbxGW' }).file, 'numdeep.sfpack');
});

test('selects buyer language from locale and country fallback', () => {
  assert.equal(emailLanguage('ro-RO', 'ES'), 'ro');
  assert.equal(emailLanguage('es', 'RO'), 'es');
  assert.equal(emailLanguage('auto', 'RO'), 'ro');
  assert.equal(emailLanguage(null, 'ES'), 'es');
  assert.equal(emailLanguage('auto', 'US'), 'en');
});

test('email contains requested steps, backup link, and pack details safely', () => {
  const pack = PACKS.plink_1UVy37DpTwoDeZJnPhVDbxGW;
  const email = buildEmail(pack, '<activation&code>', 'ro', 'https://example.test/numdeep.sfpack');
  assert.equal(email.subject, 'Pachetul tău Strategic Flow + codul de activare');
  assert.match(email.html, /&lt;activation&amp;code&gt;/);
  assert.match(email.text, /Contul meu/);
  assert.match(email.text, /Pachete/);
  assert.match(email.text, /numdeep.sfpack/);
  assert.match(email.text, /offline/);
});

test('delivery attaches the cached pack and records Resend message id', async () => {
  const queries = [];
  const delivery = {
    id: 5, checkout_session_id: 'cs_example', buyer_email: 'buyer@example.test',
    pack: 'numdeep', locale: 'ro', billing_country: 'RO', updated_at: new Date('2026-10-29T00:00:00Z')
  };
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    return sql.includes("SET status='sending'") ? { rows: [delivery] } : { rows: [] };
  } };
  let sent;
  const service = createNumerologieDeliveryService({
    pool,
    resend: { emails: { send: async (payload, options) => { sent = { payload, options }; return { data: { id: 're_test' } }; } } },
    stripe: {},
    env: { NUMEROLOGIE_CODE_NUMDEEP: 'code-123' },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('fake-pack') }),
    sleep: async () => {}
  });
  await service.processDelivery(5);
  assert.equal(sent.payload.to, delivery.buyer_email);
  assert.equal(sent.payload.attachments[0].filename, 'numdeep.sfpack');
  assert.equal(Buffer.from(sent.payload.attachments[0].content, 'base64').toString(), 'fake-pack');
  assert.match(sent.payload.subject, /Pachetul tău/);
  assert.equal(sent.options.idempotencyKey, `numerologie-cs_example-${delivery.updated_at.getTime()}`);
  assert.ok(queries.some(query => query.sql.includes("SET status='sent'") && query.params[1] === 're_test'));
});

test('missing activation code records failure and alerts the administrator', async () => {
  const updates = [];
  const delivery = {
    id: 8, checkout_session_id: 'cs_missing', buyer_email: 'buyer@example.test',
    pack: 'bundle', locale: 'en', updated_at: new Date()
  };
  const pool = { query: async (sql, params) => {
    if (sql.includes("SET status='sending'")) return { rows: [delivery] };
    updates.push({ sql, params });
    return { rows: [] };
  } };
  const sends = [];
  const service = createNumerologieDeliveryService({
    pool,
    resend: { emails: { send: async payload => { sends.push(payload); return { data: { id: 'alert-id' } }; } } },
    stripe: {},
    env: {},
    fetchImpl: async () => { throw new Error('should not download without code'); },
    sleep: async () => {}
  });
  await service.processDelivery(8);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'strategicflow@proton.me');
  assert.match(sends[0].text, /NUMEROLOGIE_CODE_BUNDLE/);
  assert.ok(updates.some(update => update.sql.includes("SET status='failed'")));
});

test('webhook verifies raw request and queues only paid allowlisted sessions', async () => {
  let verifiedBody;
  let inserts = 0;
  const paidEvent = {
    id: 'evt_paid',
    type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_paid', payment_status: 'paid',
      payment_link: 'plink_1UVy37DpTwoDeZJnPhVDbxGW',
      customer_details: { email: 'buyer@example.test', address: { country: 'RO' } },
      locale: 'auto'
    } }
  };
  const pool = { query: async sql => {
    if (sql.includes('INSERT INTO numerologie_deliveries')) {
      inserts++;
      return { rows: [{ id: 12 }] };
    }
    return { rows: [] };
  } };
  const service = createNumerologieDeliveryService({
    pool, resend: { emails: { send: async () => ({ data: { id: 'unused' } }) } },
    stripe: { webhooks: { constructEvent: (body, signature, secret) => {
      verifiedBody = { body, signature, secret };
      return paidEvent;
    } } },
    env: { NUMEROLOGIE_STRIPE_WEBHOOK_SECRET: 'whsec_test' }
  });
  const response = {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
  const raw = Buffer.from('raw-stripe-event');
  await service.handleWebhook({ body: raw, get: name => name === 'stripe-signature' ? 'sig_test' : '' }, response);
  assert.equal(verifiedBody.body, raw);
  assert.equal(verifiedBody.signature, 'sig_test');
  assert.equal(verifiedBody.secret, 'whsec_test');
  assert.equal(response.code, 200);
  assert.deepEqual(response.body, { received: true, queued: true });
  assert.equal(inserts, 1);
});
