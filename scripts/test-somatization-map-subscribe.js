'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSomatizationMapSubscribeService } = require('../somatization-map-subscribe');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end() { this.ended = true; return this; }
  };
}

function request(body = {}, { origin, ip = '203.0.113.10' } = {}) {
  return {
    body,
    ip,
    socket: { remoteAddress: ip },
    get(name) { return name.toLowerCase() === 'origin' ? origin : undefined; }
  };
}

function createHarness({ insertResult, sendResult = { data: { id: 're_guide_1' } } } = {}) {
  const queries = [];
  const emails = [];
  let inserted = false;
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('INSERT')) {
        if (insertResult) return insertResult;
        if (inserted) return { rows: [] };
        inserted = true;
        return { rows: [{ email: params[0] }] };
      }
      return { rows: [] };
    }
  };
  const resend = {
    emails: {
      async send(message) {
        emails.push(message);
        return sendResult;
      }
    }
  };
  const logger = { warn() {}, error() {} };
  return {
    service: createSomatizationMapSubscribeService({ pool, resend, env: {}, logger }),
    queries,
    emails
  };
}

test('rejects invalid email and missing consent', async () => {
  const { service, queries, emails } = createHarness();
  const invalidEmail = responseRecorder();
  await service.handleSubscribe(request({ email: 'not-an-email', consent: true }), invalidEmail);
  assert.equal(invalidEmail.statusCode, 400);
  const noConsent = responseRecorder();
  await service.handleSubscribe(request({ email: 'person@example.com', consent: false }), noConsent);
  assert.equal(noConsent.statusCode, 400);
  assert.equal(queries.length, 0);
  assert.equal(emails.length, 0);
});

test('silently accepts a filled honeypot without storing or sending', async () => {
  const { service, queries, emails } = createHarness();
  for (const website of ['bot-filled-this', false, 0]) {
    const res = responseRecorder();
    await service.handleSubscribe(request({ website }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  }
  assert.equal(queries.length, 0);
  assert.equal(emails.length, 0);
});

test('sends the selected language guide once and returns the same success for a duplicate', async () => {
  const { service, queries, emails } = createHarness();
  const body = { email: ' Reader@Example.com ', lang: 'es', consent: true, website: '' };
  const first = responseRecorder();
  await service.handleSubscribe(request(body), first);
  const duplicate = responseRecorder();
  await service.handleSubscribe(request(body), duplicate);
  assert.deepEqual(first.body, { ok: true });
  assert.deepEqual(duplicate.body, { ok: true });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'reader@example.com');
  assert.equal(emails[0].from, 'Somatization Map <noreply@strategicflow.tech>');
  assert.equal(emails[0].replyTo, 'strategicflow@proton.me');
  assert.equal(emails[0].subject, 'Tu guía gratuita Mapa de la Somatización');
  assert.match(emails[0].text, /guide\.html#es/);
  assert.equal(queries.filter(query => query.sql.includes('INSERT')).length, 2);
  assert.deepEqual(queries[0].params.slice(0, 2), ['reader@example.com', 'es']);
  assert.match(queries[0].params[2], /^[a-f0-9]{64}$/);
  assert.notEqual(queries[0].params[2], '203.0.113.10');
  assert.match(queries[0].sql, /ON CONFLICT \(email\)/);
});

test('limits CORS to the two approved origins', async () => {
  const { service } = createHarness();
  const allowed = responseRecorder();
  await service.handleOptions(request({}, { origin: 'https://strategicflow.tech' }), allowed);
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://strategicflow.tech');
  assert.equal(allowed.headers['access-control-allow-methods'], 'POST, OPTIONS');

  const rejected = responseRecorder();
  await service.handleOptions(request({}, { origin: 'https://evil.example' }), rejected);
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers['access-control-allow-origin'], undefined);

  const www = responseRecorder();
  await service.handleSubscribe(request({
    email: 'person@example.com',
    consent: true
  }, { origin: 'https://www.strategicflow.tech' }), www);
  assert.equal(www.headers['access-control-allow-origin'], 'https://www.strategicflow.tech');
});

test('applies the hourly IP and email request limits', async () => {
  let sends = 0;
  const registeredEmails = new Set();
  const pool = {
    query: async (sql, params = []) => {
      if (!sql.includes('INSERT')) return { rows: [] };
      if (registeredEmails.has(params[0])) return { rows: [] };
      registeredEmails.add(params[0]);
      return { rows: [{ email: params[0] }] };
    }
  };
  const service = createSomatizationMapSubscribeService({
    pool,
    resend: { emails: { send: async () => { sends++; return { data: { id: 're_guide' } }; } } },
    env: {},
    logger: { warn() {}, error() {} },
    now: () => 1_800_000_000_000
  });
  for (let i = 0; i < 5; i++) {
    const res = responseRecorder();
    await service.handleSubscribe(request({
      email: `person${i}@example.com`,
      consent: true
    }, { ip: '203.0.113.20' }), res);
    assert.deepEqual(res.body, { ok: true });
  }
  const ipLimited = responseRecorder();
  await service.handleSubscribe(request({
    email: 'another@example.com',
    consent: true
  }, { ip: '203.0.113.20' }), ipLimited);
  assert.equal(ipLimited.statusCode, 429);

  for (let i = 0; i < 5; i++) {
    const res = responseRecorder();
    await service.handleSubscribe(request({
      email: 'shared@example.com',
      consent: true
    }, { ip: `203.0.113.${30 + i}` }), res);
    assert.equal(res.statusCode, 200);
  }
  const emailLimited = responseRecorder();
  await service.handleSubscribe(request({
    email: 'shared@example.com',
    consent: true
  }, { ip: '203.0.113.99' }), emailLimited);
  assert.equal(emailLimited.statusCode, 429);
  assert.equal(sends, 6);
});

