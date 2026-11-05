'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createSomatizationMapReviewsService } = require('../somatization-map-reviews');

function responseRecorder() {
  return {
    statusCode: 200, body: null, headers: {}, contentType: '', ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    type(value) { this.contentType = value; return this; },
    end() { this.ended = true; return this; }
  };
}

function request(body = {}, { origin, ip = '203.0.113.10', query = {} } = {}) {
  return {
    body, query, ip, socket: { remoteAddress: ip },
    get(name) { return name.toLowerCase() === 'origin' ? origin : undefined; }
  };
}

function harness() {
  const queries = [];
  const emails = [];
  let nextId = 7;
  let review;
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      if (/INSERT INTO somatization_map_reviews/.test(sql)) {
        if (review && ['pending_confirmation', 'confirmed', 'approved'].includes(review.status)) return { rows: [] };
        review = { id: nextId++, first_name: params[0], email: params[1], rating: params[2], review_text: params[3], lang: params[4], status: 'pending_confirmation', confirmation_token_hash: params[5], moderation_notified_at: null };
        return { rows: [{ id: review.id }] };
      }
      if (/UPDATE somatization_map_reviews SET status='confirmed'/.test(sql)) {
        if (review?.confirmation_token_hash === params[0] && review.status === 'pending_confirmation') {
          review.status = 'confirmed';
          return { rows: [{ ...review }] };
        }
        return { rows: [] };
      }
      if (/SELECT .*confirmation_token_hash/.test(sql)) return { rows: review?.confirmation_token_hash === params[0] ? [{ ...review }] : [] };
      if (/SET moderation_notified_at/.test(sql)) { if (review) review.moderation_notified_at = true; return { rows: [] }; }
      if (/SET status=\$1/.test(sql)) {
        if (review?.id === Number(params[1]) && review.status === 'confirmed') {
          review.status = params[0];
          return { rows: [{ id: review.id }] };
        }
        return { rows: [] };
      }
      if (/SELECT first_name,rating,review_text/.test(sql)) return { rows: review?.status === 'approved' ? [{ first_name: review.first_name, rating: review.rating, text: review.review_text, lang: review.lang, created_at: '2026-11-05T00:00:00Z' }] : [] };
      if (/COUNT\(\*\)::int AS count/.test(sql)) return { rows: [{ count: review?.status === 'approved' ? 1 : 0, average: review?.status === 'approved' ? review.rating : 0 }] };
      return { rows: [] };
    }
  };
  const service = createSomatizationMapReviewsService({
    pool,
    resend: { emails: { send: async message => { emails.push(message); return { data: { id: `re_${emails.length}` } }; } } },
    env: { SESSION_SECRET: 'test-session-secret' },
    logger: { warn() {}, error() {} },
    randomBytes: () => Buffer.alloc(32, 7),
    now: () => 1_800_000_000_000,
    baseUrl: 'https://app.example.test'
  });
  return { service, queries, emails, getReview: () => review };
}

const validReview = {
  firstName: 'Ana', email: 'ana@example.com', rating: 5,
  text: 'O resursă utilă și clară.', lang: 'ro', consent: true, website: ''
};

test('validates review fields, consent, language, and honeypot without storing bots', async () => {
  const { service, queries, emails } = harness();
  let index = 0;
  for (const patch of [
    { firstName: '' }, { firstName: 'x'.repeat(61) }, { email: 'bad' },
    { rating: 6 }, { rating: 1.5 }, { text: 'short' }, { text: 'x'.repeat(801) },
    { lang: 'pt' }, { consent: false }
  ]) {
    const res = responseRecorder();
    await service.handleSubmit(request({ ...validReview, ...patch }, { ip: `203.0.113.${++index}` }), res);
    assert.equal(res.statusCode, 400);
  }
  const bot = responseRecorder();
  await service.handleSubmit(request({ ...validReview, website: 'spam' }), bot);
  assert.deepEqual(bot.body, { ok: true });
  assert.equal(queries.filter(q => /INSERT INTO somatization_map_reviews/.test(q.sql)).length, 0);
  assert.equal(emails.length, 0);
});

test('stores one pending review and emails a localized confirmation link', async () => {
  const { service, queries, emails } = harness();
  const first = responseRecorder();
  await service.handleSubmit(request(validReview, { origin: 'https://strategicflow.tech' }), first);
  const duplicate = responseRecorder();
  await service.handleSubmit(request(validReview, { origin: 'https://strategicflow.tech' }), duplicate);
  assert.deepEqual(first.body, { ok: true });
  assert.deepEqual(duplicate.body, { ok: true });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].from, 'Somatization Map <noreply@strategicflow.tech>');
  assert.equal(emails[0].replyTo, 'strategicflow@proton.me');
  assert.equal(emails[0].to, 'ana@example.com');
  assert.match(emails[0].text, /antes de cualquier publicación|înainte/);
  assert.match(emails[0].text, /confirm\?token=[a-f0-9]{64}/);
  assert.match(queries.find(q => /INSERT INTO somatization_map_reviews/.test(q.sql)).params[5], /^[a-f0-9]{64}$/);
  assert.notEqual(queries.find(q => /INSERT INTO somatization_map_reviews/.test(q.sql)).params[6], '203.0.113.10');
});

test('confirmation triggers moderator email; moderation changes state only after POST', async () => {
  const { service, emails, queries, getReview } = harness();
  await service.handleSubmit(request(validReview), responseRecorder());
  const token = emails[0].text.match(/confirm\?token=([a-f0-9]{64})/)[1];
  assert.equal(emails.length, 1, 'moderator must not be emailed before email confirmation');

  const confirmed = responseRecorder();
  await service.handleConfirm(request({}, { query: { token } }), confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.match(confirmed.body, /publicată doar după|published only after/);
  assert.equal(getReview().status, 'confirmed');
  assert.equal(emails.length, 2);
  assert.equal(emails[1].to, 'strategicflow@proton.me');
  const approveUrl = emails[1].text.match(/Approve: (https:\/\/\S+)/)[1];
  const url = new URL(approveUrl);
  const params = Object.fromEntries(url.searchParams.entries());

  const viewed = responseRecorder();
  await service.handleModerationGet(request({}, { query: params }), viewed);
  assert.equal(getReview().status, 'confirmed', 'GET must not moderate');
  assert.match(viewed.body, /method="post"/);

  const approved = responseRecorder();
  await service.handleModerationPost(request(params), approved);
  assert.equal(getReview().status, 'approved');
  assert.ok(queries.some(q => /SET status=\$1/.test(q.sql)));

  const publicList = responseRecorder();
  await service.handlePublicList(request({}, { origin: 'https://www.strategicflow.tech' }), publicList);
  assert.equal(publicList.body.count, 1);
  assert.equal(publicList.body.average, 5);
  assert.equal(publicList.body.reviews[0].first_name, 'Ana');
  assert.equal(Object.hasOwn(publicList.body.reviews[0], 'email'), false);
});

test('Express parses urlencoded moderation forms and applies approve/reject only on POST', async () => {
  for (const action of ['approve', 'reject']) {
    const { service, emails, getReview } = harness();
    await service.handleSubmit(request({ ...validReview, email: `${action}@example.com` }), responseRecorder());
    const token = emails[0].text.match(/confirm\?token=([a-f0-9]{64})/)[1];
    await service.handleConfirm(request({}, { query: { token } }), responseRecorder());
    assert.equal(getReview().status, 'confirmed');

    const moderationLabel = action === 'approve' ? 'Approve' : 'Reject';
    const moderationLine = emails[1].text.split('\n').find(line => line.startsWith(`${moderationLabel}: `));
    assert.ok(moderationLine, `expected a signed ${action} link in the moderator email`);
    const moderationLink = moderationLine.slice(moderationLabel.length + 2);
    const link = new URL(moderationLink);
    const app = express();
    app.post(
      '/api/somatization-map/reviews/moderate',
      express.urlencoded({ extended: false, limit: '2kb' }),
      service.handleModerationPost
    );
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/somatization-map/reviews/moderate`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(Object.fromEntries(link.searchParams.entries()))
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Review moderation saved/);
      assert.equal(getReview().status, action === 'approve' ? 'approved' : 'rejected');
    } finally {
      server.close();
      await once(server, 'close');
    }
  }
});

test('CORS is limited to the approved origins and public list has a short cache', async () => {
  const { service } = harness();
  const ok = responseRecorder();
  await service.handleOptions(request({}, { origin: 'https://www.strategicflow.tech' }), ok);
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://www.strategicflow.tech');
  const denied = responseRecorder();
  await service.handlePublicOptions(request({}, { origin: 'https://evil.example' }), denied);
  assert.equal(denied.statusCode, 403);
  const empty = responseRecorder();
  await service.handlePublicList(request(), empty);
  assert.deepEqual(empty.body, { reviews: [], average: 0, count: 0 });
  assert.match(empty.headers['cache-control'], /max-age=60/);
});

test('rate limits submissions by IP and by email', async () => {
  const { service } = harness();
  for (let i = 0; i < 5; i++) {
    const response = responseRecorder();
    await service.handleSubmit(request({
      ...validReview, email: `reader${i}@example.com`
    }, { ip: '203.0.113.80' }), response);
    assert.equal(response.statusCode, 200);
  }
  const ipLimited = responseRecorder();
  await service.handleSubmit(request({
    ...validReview, email: 'sixth@example.com'
  }, { ip: '203.0.113.80' }), ipLimited);
  assert.equal(ipLimited.statusCode, 429);

  const { service: emailService } = harness();
  for (let i = 0; i < 5; i++) {
    const response = responseRecorder();
    await emailService.handleSubmit(request(validReview, { ip: `203.0.113.${90 + i}` }), response);
    assert.equal(response.statusCode, 200);
  }
  const emailLimited = responseRecorder();
  await emailService.handleSubmit(request(validReview, { ip: '203.0.113.99' }), emailLimited);
  assert.equal(emailLimited.statusCode, 429);
});
