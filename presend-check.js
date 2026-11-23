'use strict';

const express = require('express');
const { safeFetchPublicUrl } = require('./safe-url-fetch');

const MAX_LINKS = 12;
const MAX_URL_LENGTH = 2048;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 5;
const LINK_TIMEOUT_MS = 6000;
const LINK_TOTAL_TIMEOUT_MS = 9000;
const LINK_CONCURRENCY = 4;

function safeDisplayUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return String(value || '').slice(0, 200);
  }
}

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 96);
}

function createRateLimiter({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
  const hits = new Map();

  return function takeSlot(key) {
    const time = now();
    const recent = (hits.get(key) || []).filter(timestamp => time - timestamp < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowMs - (time - recent[0])) / 1000)) };
    }
    recent.push(time);
    hits.set(key, recent);

    if (hits.size > 10_000) {
      for (const [storedKey, timestamps] of hits) {
        if (!timestamps.some(timestamp => time - timestamp < windowMs)) hits.delete(storedKey);
      }
    }
    return { allowed: true };
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkOneLink(rawUrl, fetchPublicUrl, totalTimeoutMs = LINK_TOTAL_TIMEOUT_MS) {
  const displayUrl = safeDisplayUrl(rawUrl);
  try {
    let response = await withTimeout(fetchPublicUrl(rawUrl, {
      method: 'HEAD',
      timeoutMs: LINK_TIMEOUT_MS,
      maxBytes: 1024,
      maxRedirects: 2,
      headers: { 'User-Agent': 'StrategicFlow-PreSendCheck/1.0' },
    }), totalTimeoutMs);
    if (response.status === 405 || response.status === 501) {
      response = await withTimeout(fetchPublicUrl(rawUrl, {
        method: 'GET',
        timeoutMs: LINK_TIMEOUT_MS,
        maxBytes: 1024,
        maxRedirects: 2,
        headers: {
          'User-Agent': 'StrategicFlow-PreSendCheck/1.0',
          Range: 'bytes=0-0',
        },
      }), totalTimeoutMs);
    }
    const finalUrl = safeDisplayUrl(response.url || rawUrl);
    const status = response.status === 404 || response.status === 410
      ? 'broken'
      : finalUrl !== displayUrl
        ? 'redirect'
        : response.status >= 200 && response.status < 300
          ? 'ok'
          : 'error';
    return {
      url: displayUrl,
      status,
      code: response.status || null,
      finalUrl,
      message: status === 'ok'
        ? 'Link responded successfully.'
        : status === 'redirect'
          ? 'Link redirected to another public URL.'
          : status === 'broken'
            ? 'The destination returned a missing-page response.'
            : 'The destination returned an HTTP error.',
    };
  } catch (error) {
    const code = String(error?.code || '');
    if (code === 'timeout') {
      return { url: displayUrl, status: 'timeout', code: null, finalUrl: null, message: 'The link check timed out.' };
    }
    if (['private_host', 'private_address', 'blocked_port', 'invalid_url', 'dns_changed'].includes(code)) {
      return { url: displayUrl, status: 'blocked', code: null, finalUrl: null, message: 'The destination was blocked by the public-address safety check.' };
    }
    return { url: displayUrl, status: 'error', code: null, finalUrl: null, message: 'The destination could not be checked.' };
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function createPreSendCheckRouter(options = {}) {
  const router = express.Router();
  const allowedOrigins = options.allowedOrigins || new Set();
  const fetchPublicUrl = options.safeFetchPublicUrl || safeFetchPublicUrl;
  const takeRateLimitSlot = options.takeRateLimitSlot || createRateLimiter();
  const linkTotalTimeoutMs = options.linkTotalTimeoutMs || LINK_TOTAL_TIMEOUT_MS;

  function cors(req, res) {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(origin)) return false;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    return true;
  }

  router.options('/links', (req, res) => {
    if (!cors(req, res)) return res.status(403).end();
    return res.status(204).end();
  });

  router.post('/links', async (req, res) => {
    if (!cors(req, res)) return res.status(403).json({ error: 'Origin not allowed.' });

    const quota = takeRateLimitSlot(clientKey(req));
    if (!quota.allowed) {
      res.setHeader('Retry-After', String(quota.retryAfter));
      return res.status(429).json({ error: 'Too many checks. Please try again shortly.' });
    }

    const links = req.body?.links;
    if (!Array.isArray(links) || links.length === 0) {
      return res.status(400).json({ error: 'Provide at least one URL to check.' });
    }
    if (links.length > MAX_LINKS) {
      return res.status(400).json({ error: `A maximum of ${MAX_LINKS} links can be checked at once.` });
    }
    if (links.some(link => typeof link !== 'string' || link.length > MAX_URL_LENGTH)) {
      return res.status(400).json({ error: 'Each URL must be a string no longer than 2,048 characters.' });
    }

    res.setHeader('Cache-Control', 'no-store');
    try {
      const results = await mapWithConcurrency(
        links,
        LINK_CONCURRENCY,
        link => checkOneLink(link, fetchPublicUrl, linkTotalTimeoutMs)
      );
      return res.json({ results, checked: results.length, stored: false });
    } catch {
      return res.status(500).json({ error: 'The link check could not be completed.' });
    }
  });

  return router;
}

module.exports = {
  MAX_LINKS,
  createPreSendCheckRouter,
  createRateLimiter,
  checkOneLink,
};
