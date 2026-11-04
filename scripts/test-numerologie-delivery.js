'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  packForPaymentLink, emailLanguage, buildEmail, PACKS, tokenMatches,
  createNumerologieDeliveryService
} = require('../numerologie-delivery');

test('maps old and new Stripe payment links to the same four packs', () => {
  assert.equal(packForPaymentLink('plink_1UVy37DpTwoDeZJnPhVDbxGW').key, 'numdeep');
  assert.equal(packForPaymentLink('plink_1UVy38DpTwoDeZJnnWdw2gCL').key, 'nlpdeep');
  assert.equal(packForPaymentLink('plink_1UVy38DpTwoDeZJnWJLPKySP').key, 'crosspro');
  assert.equal(packForPaymentLink('plink_1UVy39DpTwoDeZJnAJ7b59UP').key, 'bundle');
  assert.equal(packForPaymentLink('plink_1UY4w0DpTwoDeZJnzcunk4di').key, 'numdeep');
  assert.equal(packForPaymentLink('plink_1UY4w3DpTwoDeZJnp8NpAnCD').key, 'nlpdeep');
  assert.equal(packForPaymentLink('plink_1UY4w7DpTwoDeZJnmFljIXbV').key, 'crosspro');
  assert.equal(packForPaymentLink('plink_1UY4wADpTwoDeZJntC0bcOWR').key, 'bundle');
  assert.deepEqual(
    packForPaymentLink('plink_1UY4w0DpTwoDeZJnzcunk4di'),
    packForPaymentLink('plink_1UVy37DpTwoDeZJnPhVDbxGW')
  );
  assert.deepEqual(
    packForPaymentLink('plink_1UY4w3DpTwoDeZJnp8NpAnCD'),
    packForPaymentLink('plink_1UVy38DpTwoDeZJnnWdw2gCL')
  );
  assert.deepEqual(
    packForPaymentLink('plink_1UY4w7DpTwoDeZJnmFljIXbV'),
    packForPaymentLink('plink_1UVy38DpTwoDeZJnWJLPKySP')
  );
  assert.deepEqual(
    packForPaymentLink('plink_1UY4wADpTwoDeZJntC0bcOWR'),
    packForPaymentLink('plink_1UVy39DpTwoDeZJnAJ7b59UP')
  );
  assert.equal(packForPaymentLink('plink_other'), null);
  assert.equal(packForPaymentLink({ id: 'plink_1UVy37DpTwoDeZJnPhVDbxGW' }).file, 'numdeep.sfpack');
});

test('selects buyer language from locale and country fallback', () => {
  assert.equal(emailLanguage('ro-RO', 'ES'), 'ro');
  assert.equal(emailLanguage('es', 'RO'), 'es');
  assert.equal(emailLanguage('auto', 'RO'), 'ro');
  assert.equal(emailLanguage(null, 'ES'), 'es');
  assert.equal(emailLanguage('auto', 'US'), 'en');
  assert.equal(emailLanguage('pt', 'ES'), 'pt');
  assert.equal(emailLanguage('pt-BR', 'US'), 'pt');
  assert.equal(emailLanguage('pt_BR', 'US'), 'pt');
  assert.equal(emailLanguage('en-US', 'BR'), 'en');
  assert.equal(emailLanguage(null, 'BR'), 'pt');
  assert.equal(emailLanguage('auto', 'PT'), 'pt');
  assert.equal(emailLanguage('', 'ES'), 'es');
  assert.equal(emailLanguage('auto', 'MD'), 'ro');
  assert.equal(emailLanguage(null, 'US'), 'en');
  assert.equal(emailLanguage('fr-FR', 'BR'), 'en');
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

test('Portuguese emails use the requested subject, localized pack names, activation steps and support', () => {
  const expectedNames = {
    numdeep: 'Numerologia Deep',
    nlpdeep: 'PNL Deep',
    crosspro: 'Perfil Cruzado Pro',
    bundle: 'Bundle completo'
  };
  for (const pack of Object.values(PACKS)) {
    const email = buildEmail(pack, 'test-code-placeholder', 'pt', `https://example.test/${pack.file}`);
    assert.equal(email.subject, 'Seu pacote Strategic Flow e o código de ativação');
    assert.match(email.text, new RegExp(expectedNames[pack.key]));
    assert.match(email.text, /Meu perfil/);
    assert.match(email.text, /Pacotes/);
    assert.match(email.text, /Desbloquear/);
    assert.match(email.text, /offline/);
    assert.match(email.text, /strategicflow@proton\.me/);
    assert.match(email.text, new RegExp(pack.file));
  }
});

test('delivery fetches current pack bytes without cache and records Resend message id', async () => {
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
  let fetchCount = 0;
  const fetchRequests = [];
  const service = createNumerologieDeliveryService({
    pool,
    resend: { emails: { send: async (payload, options) => { sent = { payload, options }; return { data: { id: 're_test' } }; } } },
    stripe: {},
    env: { NUMEROLOGIE_CODE_NUMDEEP: 'code-123' },
    fetchImpl: async (url, options) => {
      fetchCount++;
      fetchRequests.push({ url: String(url), options });
      return { ok: true, arrayBuffer: async () => Buffer.from(`fresh-pack-${fetchCount}`) };
    },
    sleep: async () => {}
  });
  await service.processDelivery(5);
  assert.equal(sent.payload.to, delivery.buyer_email);
  assert.equal(sent.payload.attachments[0].filename, 'numdeep.sfpack');
  assert.equal(Buffer.from(sent.payload.attachments[0].content, 'base64').toString(), 'fresh-pack-1');
  assert.equal(fetchRequests[0].url, 'https://strategicflow.tech/numerologie-nlp/packs/numdeep.sfpack');
  assert.equal(fetchRequests[0].options.cache, 'no-store');
  assert.equal(fetchRequests[0].options.headers['Cache-Control'], 'no-cache');
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

test('test token comparison accepts only the exact token', () => {
  assert.equal(tokenMatches('a-long-test-token', 'a-long-test-token'), true);
  assert.equal(tokenMatches('a-long-test-token', 'a-long-test-token-x'), false);
  assert.equal(tokenMatches('', 'anything'), false);
});

test('test delivery sends all four allowlisted packs through the shared delivery function', async () => {
  const insertedRows = [];
  const attempts = [];
  const sent = [];
  let fetchCount = 0;
  const fetchRequests = [];
  let nextId = 1;
  const client = { query: async (sql, params = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ sends: 0 }] };
    if (sql.includes('INSERT INTO numerologie_deliveries')) {
      const row = {
        id: nextId++, checkout_session_id: params[1], buyer_email: params[2], pack: params[3],
        locale: params[4], billing_country: null, updated_at: new Date(), is_test: true
      };
      insertedRows.push(row);
      return { rows: [row] };
    }
    if (sql.includes('INSERT INTO numerologie_test_send_attempts')) {
      attempts.push(params[0]);
      return { rows: [] };
    }
    throw new Error(`Unexpected client query: ${sql}`);
  }, release() {} };
  const pool = {
    connect: async () => client,
    query: async (sql, params) => {
      if (sql.includes("SET status='sent'")) return { rows: [], params };
      throw new Error(`Unexpected pool query: ${sql}`);
    }
  };
  const service = createNumerologieDeliveryService({
    pool,
    resend: { emails: { send: async payload => { sent.push(payload); return { data: { id: `re_test_${sent.length}` } }; } } },
    stripe: {},
    env: {
      NUMEROLOGIE_CODE_NUMDEEP: 'SFNN-AAAA-BBBB-CCCC',
      NUMEROLOGIE_CODE_NLPDEEP: 'SFNN-DDDD-EEEE-FFFF',
      NUMEROLOGIE_CODE_CROSSPRO: 'SFNN-GGGG-HHHH-IIII',
      NUMEROLOGIE_CODE_BUNDLE: 'SFNN-JJJJ-KKKK-LLLL'
    },
    fetchImpl: async (url, options) => {
      fetchCount++;
      fetchRequests.push({ url: String(url), options });
      return { ok: true, arrayBuffer: async () => Buffer.from(`pack-binary-${fetchCount}`) };
    },
    sleep: async () => {}
  });

  const results = await service.sendTestDeliveries({
    to: 'consultantcalatorii@gmail.com',
    packKeys: ['numdeep', 'nlpdeep', 'crosspro', 'bundle'],
    language: 'pt'
  });
  assert.equal(results.length, 4);
  assert.deepEqual(results.map(result => result.status), ['sent', 'sent', 'sent', 'sent']);
  assert.deepEqual(results.map(result => result.attachmentFilename), ['numdeep.sfpack', 'nlpdeep.sfpack', 'crosspro.sfpack', 'bundle.sfpack']);
  assert.ok(results.every(result => result.language === 'pt' && result.codeFormatPresent));
  assert.ok(sent.slice(0, 4).every(message => message.subject === 'Seu pacote Strategic Flow e o código de ativação'));
  assert.deepEqual(fetchRequests.map(request => request.url.split('/').at(-1)), ['numdeep.sfpack', 'nlpdeep.sfpack', 'crosspro.sfpack', 'bundle.sfpack']);
  assert.ok(fetchRequests.every(request => request.options.cache === 'no-store'));
  const repeatResults = await service.sendTestDeliveries({
    to: 'consultantcalatorii@gmail.com', packKeys: ['numdeep'], language: 'pt'
  });
  assert.equal(repeatResults[0].status, 'sent');
  assert.equal(fetchCount, 5);
  assert.equal(Buffer.from(sent[4].attachments[0].content, 'base64').toString(), 'pack-binary-5');
  assert.equal(insertedRows.length, 5);
  assert.ok(insertedRows.every(row => row.is_test));
  assert.equal(attempts.length, 5);
  assert.equal(sent.length, 5);
  assert.ok(sent.every(message => message.to === 'consultantcalatorii@gmail.com'));
});

test('test delivery refuses non-allowlisted recipients without touching the database', async () => {
  let connected = false;
  const service = createNumerologieDeliveryService({
    pool: { connect: async () => { connected = true; throw new Error('should not connect'); } },
    resend: { emails: { send: async () => ({ data: { id: 'unused' } }) } },
    stripe: {}, env: {}
  });
  await assert.rejects(
    service.sendTestDeliveries({ to: 'other@example.com', packKeys: ['numdeep'] }),
    error => error.code === 'recipient_not_allowed'
  );
  assert.equal(connected, false);
});

test('test delivery rate limit reserves all pack sends atomically', async () => {
  let deliveryInserts = 0;
  const client = { query: async sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ sends: 8 }] };
    if (sql.includes('INSERT INTO numerologie_deliveries')) deliveryInserts++;
    return { rows: [] };
  }, release() {} };
  const service = createNumerologieDeliveryService({
    pool: { connect: async () => client },
    resend: { emails: { send: async () => ({ data: { id: 'unused' } }) } },
    stripe: {}, env: {}
  });
  await assert.rejects(
    service.sendTestDeliveries({
      to: 'consultantcalatorii@gmail.com',
      packKeys: ['numdeep', 'nlpdeep', 'crosspro']
    }),
    error => error.code === 'rate_limited'
  );
  assert.equal(deliveryInserts, 0);
});
