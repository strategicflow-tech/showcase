'use strict';

const crypto = require('node:crypto');

const ALLOWED_ORIGINS = new Set([
  'https://strategicflow.tech',
  'https://www.strategicflow.tech'
]);
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT = 5;

const TEMPLATES = Object.freeze({
  en: {
    subject: 'Your free Somatization Map guide',
    body: (url) => `Thank you for requesting the guide. You can read it here: ${url}\n\nThis guide is educational and is not medical advice.\n\nYou gave us your email to receive this guide. You can reply to strategicflow@proton.me at any time to ask us to delete it.`
  },
  ro: {
    subject: 'Ghidul tău gratuit Harta Somatizării',
    body: (url) => `Îți mulțumim că ai solicitat ghidul. Îl poți citi aici: ${url}\n\nAcest ghid are scop educațional și nu reprezintă sfat medical.\n\nNe-ai oferit adresa de e-mail pentru a primi ghidul. Poți scrie oricând la strategicflow@proton.me pentru a solicita ștergerea ei.`
  },
  es: {
    subject: 'Tu guía gratuita Mapa de la Somatización',
    body: (url) => `Gracias por solicitar la guía. Puedes leerla aquí: ${url}\n\nEsta guía es educativa y no constituye consejo médico.\n\nNos diste tu correo para recibir esta guía. Puedes escribir a strategicflow@proton.me en cualquier momento para pedir que lo eliminemos.`
  },
  fr: {
    subject: 'Votre guide gratuit Carte de la Somatisation',
    body: (url) => `Merci d’avoir demandé le guide. Vous pouvez le lire ici : ${url}\n\nCe guide est éducatif et ne constitue pas un avis médical.\n\nVous nous avez communiqué votre adresse e-mail pour recevoir ce guide. Vous pouvez écrire à strategicflow@proton.me à tout moment pour demander sa suppression.`
  }
});

function createSomatizationMapSubscribeService({ pool, resend, env = process.env, logger = console, now = Date.now }) {
  const ipRequests = new Map();
  const emailRequests = new Map();
  let requestsSinceCleanup = 0;

  function applyCors(req, res) {
    const origin = req.get('origin');
    if (!ALLOWED_ORIGINS.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return true;
  }

  function handleOptions(req, res) {
    if (!applyCors(req, res)) return res.status(403).json({ ok: false, error: 'forbidden' });
    return res.status(204).end();
  }

  function checkLimit(map, key, timestamp) {
    const active = (map.get(key) || []).filter(value => value > timestamp - RATE_WINDOW_MS);
    map.set(key, active);
    return active.length < RATE_LIMIT;
  }

  function recordRequest(map, key, timestamp) {
    const active = map.get(key) || [];
    active.push(timestamp);
    map.set(key, active);
  }

  function pruneLimits(timestamp) {
    requestsSinceCleanup++;
    if (requestsSinceCleanup < 100) return;
    requestsSinceCleanup = 0;
    for (const map of [ipRequests, emailRequests]) {
      for (const [key, values] of map) {
        const active = values.filter(value => value > timestamp - RATE_WINDOW_MS);
        if (active.length) map.set(key, active);
        else map.delete(key);
      }
    }
  }

  function error(res, status, code) {
    return res.status(status).json({ ok: false, error: code });
  }

  async function handleSubscribe(req, res) {
    const origin = req.get('origin');
    if (origin && !applyCors(req, res)) return error(res, 403, 'forbidden');
    if (!origin) res.setHeader('Vary', 'Origin');

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const website = body.website;
    if (website !== undefined && website !== null && (typeof website !== 'string' || website.trim() !== '')) {
      return res.status(200).json({ ok: true });
    }

    const timestamp = now();
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    pruneLimits(timestamp);
    if (!checkLimit(ipRequests, ipHash, timestamp)) {
      return error(res, 429, 'request_limit_reached');
    }
    recordRequest(ipRequests, ipHash, timestamp);

    const lang = body.lang === undefined ? 'en' : body.lang;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return error(res, 400, 'invalid_request');
    }
    if (body.consent !== true || !Object.hasOwn(TEMPLATES, lang)) {
      return error(res, 400, 'invalid_request');
    }

    const emailHash = crypto.createHash('sha256').update(email).digest('hex');
    if (!checkLimit(emailRequests, emailHash, timestamp)) {
      return error(res, 429, 'request_limit_reached');
    }
    recordRequest(emailRequests, emailHash, timestamp);

    let reservation;
    try {
      reservation = await pool.query(
        `INSERT INTO somatization_map_subscribers
           (email, lang, consent_at, ip_hash, send_status, last_sent_at, created_at, updated_at)
         VALUES ($1,$2,NOW(),$3,'sending',NOW(),NOW(),NOW())
         ON CONFLICT (email) DO UPDATE SET
           lang=EXCLUDED.lang,
           consent_at=EXCLUDED.consent_at,
           ip_hash=EXCLUDED.ip_hash,
           send_status='sending',
           last_sent_at=NOW(),
           updated_at=NOW()
         WHERE somatization_map_subscribers.last_sent_at IS NULL
            OR somatization_map_subscribers.last_sent_at <= NOW() - INTERVAL '24 hours'
         RETURNING email`,
        [email, lang, ipHash]
      );
    } catch {
      logger.warn('[somatization-map-subscribe] could not record signup');
      return error(res, 503, 'temporarily_unavailable');
    }

    if (!reservation.rows.length) return res.status(200).json({ ok: true });

    const guideUrl = `https://strategicflow.tech/somatization-map/guide.html#${lang}`;
    const template = TEMPLATES[lang];
    const text = template.body(guideUrl);
    const html = `<div data-readable-email="v2" style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#172033;line-height:1.6"><p>${text.split('\n\n').map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('</p><p>')}</p></div>`;

    try {
      const result = await resend.emails.send({
        from: 'Somatization Map <noreply@strategicflow.tech>',
        replyTo: 'strategicflow@proton.me',
        to: email,
        subject: template.subject,
        text,
        html,
        _skipGlobalCooldown: true,
        _skipGlobalEmailLog: true
      });
      if (result?.error) throw new Error('resend_send_failed');
    } catch {
      await pool.query(
        `UPDATE somatization_map_subscribers
         SET send_status='failed', last_sent_at=NULL, updated_at=NOW()
         WHERE email=$1 AND send_status='sending'`,
        [email]
      ).catch(() => {});
      logger.warn('[somatization-map-subscribe] guide email delivery failed');
      return error(res, 502, 'delivery_failed');
    }

    try {
      await pool.query(
        `UPDATE somatization_map_subscribers
         SET send_status='sent', last_sent_at=NOW(), updated_at=NOW()
         WHERE email=$1 AND send_status='sending'`,
        [email]
      );
    } catch {
      logger.warn('[somatization-map-subscribe] delivery status update failed');
      return error(res, 503, 'temporarily_unavailable');
    }
    return res.status(200).json({ ok: true });
  }

  return { handleOptions, handleSubscribe };
}

module.exports = { ALLOWED_ORIGINS, TEMPLATES, createSomatizationMapSubscribeService };
