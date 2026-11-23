'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPreSendCheckRouter, createRateLimiter, MAX_LINKS } = require('../presend-check');
const { safeFetchPublicUrl } = require('../safe-url-fetch');

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
  app.use('/api/presend', createPreSendCheckRouter({
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
  });
});

test('allows a same-origin request from the running preview host', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/presend', createPreSendCheckRouter({
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
  app.use('/api/presend', createPreSendCheckRouter({
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
  app.use('/api/presend', createPreSendCheckRouter({
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
