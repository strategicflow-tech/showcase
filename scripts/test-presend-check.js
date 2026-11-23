'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const { createPreSendCheckRouter, createRateLimiter, MAX_LINKS } = require('../presend-check');
const { WEEKLY_LIMIT, WEEKLY_WINDOW_MS } = require('../presend-weekly-quota');
const { safeFetchPublicUrl } = require('../safe-url-fetch');

function createMemoryWeeklyQuota({ now = () => Date.now() } = {}) {
  const events = [];

  function currentUsage(ip) {
    const cutoff = now() - WEEKLY_WINDOW_MS;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].createdAt < cutoff) events.splice(index, 1);
    }
    return events.filter(event => event.ip === ip).sort((a, b) => a.createdAt - b.createdAt);
  }

  async function reserve(ip) {
    const time = now();
    const recent = currentUsage(ip);
    if (recent.length >= WEEKLY_LIMIT) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(recent[0].createdAt + WEEKLY_WINDOW_MS).toISOString(),
      };
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const event = { ip, token, createdAt: time, used: false };
    events.push(event);
    return {
      allowed: true,
      remaining: WEEKLY_LIMIT - recent.length - 1,
      resetAt: new Date((recent[0]?.createdAt ?? time) + WEEKLY_WINDOW_MS).toISOString(),
      checkToken: token,
    };
  }

  async function consumeReservation(ip, token) {
    const event = events.find(item => item.ip === ip && item.token === token && !item.used);
    if (!event || event.createdAt < now() - WEEKLY_WINDOW_MS) return { allowed: false };
    event.used = true;
    const recent = currentUsage(ip);
    return {
      allowed: true,
      remaining: WEEKLY_LIMIT - recent.length,
      resetAt: new Date(recent[0].createdAt + WEEKLY_WINDOW_MS).toISOString(),
    };
  }

  return { reserve, consumeReservation, events };
}

function createTestRouter(options = {}) {
  return createPreSendCheckRouter({
    allowedOrigins: new Set(['https://strategicflow.tech']),
    weeklyQuota: createMemoryWeeklyQuota(),
    ...options,
  });
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('allows the strategicflow.tech origin and responds to preflight', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createTestRouter({
    allowedOrigins: new Set(['https://strategicflow.tech']),
    safeFetchPublicUrl: async () => ({ status: 200, url: 'https://example.com/' }),
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://strategicflow.tech' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://strategicflow.tech');

    const quotaPreflight = await fetch(`${baseUrl}/api/presend/quota`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://strategicflow.tech' },
    });
    assert.equal(quotaPreflight.status, 204);
    assert.equal(quotaPreflight.headers.get('access-control-allow-origin'), 'https://strategicflow.tech');
  });
});

test('allows a same-origin request from the running preview host', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createTestRouter({
    safeFetchPublicUrl: async url => ({ status: 200, url }),
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: ['https://example.com/'] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), baseUrl);
  });
});

test('returns OK, redirect, broken, and timeout statuses without storing submitted content', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createTestRouter({
    allowedOrigins: new Set(['https://strategicflow.tech']),
    safeFetchPublicUrl: async url => {
      if (url.includes('timeout')) throw Object.assign(new Error('timeout'), { code: 'timeout' });
      if (url.includes('missing')) return { status: 404, url };
      if (url.includes('redirect')) return { status: 200, url: 'https://destination.example/final' };
      return { status: 200, url };
    },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'POST',
      headers: { Origin: 'https://strategicflow.tech', 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: [
        'https://example.com/ok',
        'https://example.com/redirect',
        'https://example.com/missing',
        'https://example.com/timeout',
      ] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json();
    assert.deepEqual(payload.results.map(result => result.status), ['ok', 'redirect', 'broken', 'timeout']);
    assert.equal(payload.stored, false);
    assert.equal(JSON.stringify(payload).includes('subject'), false);
  });
});

test('blocks untrusted origins, oversized batches, and private destinations', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createTestRouter({
    allowedOrigins: new Set(['https://strategicflow.tech']),
    safeFetchPublicUrl: async () => {
      throw Object.assign(new Error('blocked'), { code: 'private_address' });
    },
  }));

  await withServer(app, async baseUrl => {
    const disallowed = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'POST',
      headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: ['https://example.com'] }),
    });
    assert.equal(disallowed.status, 403);

    const tooMany = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'POST',
      headers: { Origin: 'https://strategicflow.tech', 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: Array(MAX_LINKS + 1).fill('https://example.com') }),
    });
    assert.equal(tooMany.status, 400);

    const blocked = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'POST',
      headers: { Origin: 'https://strategicflow.tech', 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: ['http://127.0.0.1/'] }),
    });
    assert.equal((await blocked.json()).results[0].status, 'blocked');
  });
});

test('rate limits requests per client', () => {
  let time = 1000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => time });
  assert.equal(limiter('client').allowed, true);
  assert.equal(limiter('client').allowed, true);
  assert.equal(limiter('client').allowed, false);
  time += 60_001;
  assert.equal(limiter('client').allowed, true);
});

test('reserves ten checks per rolling week and reports the next reset time', async () => {
  let time = Date.parse('2026-11-23T12:00:00.000Z');
  const weeklyQuota = createMemoryWeeklyQuota({ now: () => time });
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createTestRouter({
    weeklyQuota,
    takeQuotaRateLimitSlot: createRateLimiter({ limit: 100 }),
  }));

  await withServer(app, async baseUrl => {
    const requestQuota = () => fetch(`${baseUrl}/api/presend/quota`, {
      method: 'POST',
      headers: { Origin: 'https://strategicflow.tech', 'Content-Type': 'application/json' },
      body: '{}',
    });

    for (let index = 0; index < WEEKLY_LIMIT; index += 1) {
      const response = await requestQuota();
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.remaining, WEEKLY_LIMIT - index - 1);
      assert.ok(payload.checkToken);
    }
    const blocked = await requestQuota();
    assert.equal(blocked.status, 429);
    const payload = await blocked.json();
    assert.equal(payload.error, 'weekly_limit');
    assert.equal(payload.remaining, 0);
    assert.equal(payload.resetAt, '2026-11-30T12:00:00.000Z');
    assert.match(payload.message, /10 free checks this week/);

    time += WEEKLY_WINDOW_MS + 1;
    const reset = await requestQuota();
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).remaining, 9);
  });
});

test('redeems a quota reservation once so a link check does not consume twice', async () => {
  const weeklyQuota = createMemoryWeeklyQuota();
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createTestRouter({
    weeklyQuota,
    takeRateLimitSlot: createRateLimiter({ limit: 100 }),
    takeQuotaRateLimitSlot: createRateLimiter({ limit: 100 }),
    safeFetchPublicUrl: async url => ({ status: 200, url }),
  }));

  await withServer(app, async baseUrl => {
    const quotaResponse = await fetch(`${baseUrl}/api/presend/quota`, {
      method: 'POST',
      headers: { Origin: 'https://strategicflow.tech', 'Content-Type': 'application/json' },
      body: '{}',
    });
    const quota = await quotaResponse.json();
    const linksResponse = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'POST',
      headers: { Origin: 'https://strategicflow.tech', 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: ['https://example.com/'], checkToken: quota.checkToken }),
    });
    assert.equal(linksResponse.status, 200);
    assert.equal((await linksResponse.json()).checked, 1);
    assert.equal(weeklyQuota.events.length, 1);

    const replay = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'POST',
      headers: { Origin: 'https://strategicflow.tech', 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: ['https://example.com/'], checkToken: quota.checkToken }),
    });
    assert.equal(replay.status, 403);
    assert.equal(weeklyQuota.events.length, 1);
  });
});

test('a direct link request without a reservation consumes a weekly check', async () => {
  const weeklyQuota = createMemoryWeeklyQuota();
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createTestRouter({
    weeklyQuota,
    safeFetchPublicUrl: async url => ({ status: 200, url }),
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/presend/links`, {
      method: 'POST',
      headers: { Origin: 'https://strategicflow.tech', 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: ['https://example.com/'] }),
    });
    assert.equal(response.status, 200);
    assert.equal(weeklyQuota.events.length, 1);
  });
});

test('does not trust a caller-supplied forwarded IP header when no proxy is trusted', async () => {
  const seenIps = [];
  const weeklyQuota = {
    async reserve(ip) {
      seenIps.push(ip);
      return { allowed: true, remaining: 9, resetAt: new Date(Date.now() + WEEKLY_WINDOW_MS).toISOString(), checkToken: crypto.randomBytes(32).toString('base64url') };
    },
    async consumeReservation() { return { allowed: true }; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createTestRouter({ weeklyQuota }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/presend/quota`, {
      method: 'POST',
      headers: {
        Origin: 'https://strategicflow.tech',
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.99',
      },
      body: '{}',
    });
    assert.equal(response.status, 200);
  });
  assert.ok(seenIps.every(ip => ip !== '203.0.113.99'));
});

test('falls back from HEAD to a bounded GET when a host rejects HEAD', async () => {
  const calls = [];
  const result = await require('../presend-check').checkOneLink('https://example.com/page', async (_url, options) => {
    calls.push(options.method);
    if (options.method === 'HEAD') return { status: 405, url: 'https://example.com/page' };
    return { status: 200, url: 'https://example.com/page' };
  });
  assert.deepEqual(calls, ['HEAD', 'GET']);
  assert.equal(result.status, 'ok');
});

test('enforces an overall per-link timeout', async () => {
  const result = await require('../presend-check').checkOneLink(
    'https://example.com/slow',
    () => new Promise(() => {}),
    15
  );
  assert.equal(result.status, 'timeout');
});

test('the actual URL fetch guard rejects loopback destinations before requesting them', async () => {
  await assert.rejects(
    () => safeFetchPublicUrl('http://127.0.0.1/health', { timeoutMs: 100 }),
    error => error.code === 'private_address'
  );
});
