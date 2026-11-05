'use strict';

const crypto = require('node:crypto');

const ALLOWED_ORIGINS = new Set([
  'https://strategicflow.tech',
  'https://www.strategicflow.tech'
]);
const LANGUAGES = new Set(['ro', 'en', 'es', 'fr']);
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT = 5;
const PUBLIC_BASE_URL = 'https://strategic-flow-audit.replit.app';
const SENDER = 'Somatization Map <noreply@strategicflow.tech>';
const REPLY_TO = 'strategicflow@proton.me';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_COPY = Object.freeze({
  ro: {
    subject: 'Confirmă recenzia ta pentru Harta Somatizării',
    body: url => `Îți mulțumim pentru recenzie. Confirmă adresa de email aici: ${url}\n\nRecenzia va fi citită înainte de orice publicare. Adresa ta de email nu va fi afișată public niciodată. Linkul expiră în 7 zile.`
  },
  en: {
    subject: 'Confirm your Somatization Map review',
    body: url => `Thank you for your review. Confirm your email address here: ${url}\n\nYour review will be read before it can be published. Your email address will never be displayed publicly. This link expires in 7 days.`
  },
  es: {
    subject: 'Confirma tu reseña de Mapa de la Somatización',
    body: url => `Gracias por tu reseña. Confirma tu dirección de correo aquí: ${url}\n\nLeeremos la reseña antes de publicarla. Tu correo electrónico nunca se mostrará públicamente. Este enlace caduca en 7 días.`
  },
  fr: {
    subject: 'Confirmez votre avis sur la Carte de la Somatisation',
    body: url => `Merci pour votre avis. Confirmez votre adresse e-mail ici : ${url}\n\nVotre avis sera lu avant toute publication. Votre adresse e-mail ne sera jamais affichée publiquement. Ce lien expire dans 7 jours.`
  }
});

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function createSomatizationMapReviewsService({
  pool, resend, env = process.env, logger = console, now = Date.now,
  randomBytes = crypto.randomBytes, baseUrl = PUBLIC_BASE_URL
}) {
  const ipRequests = new Map();
  const emailRequests = new Map();
  let schemaPromise;
  let requestsSinceCleanup = 0;

  function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS somatization_map_reviews (
          id BIGSERIAL PRIMARY KEY,
          first_name TEXT NOT NULL,
          email TEXT NOT NULL,
          rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
          review_text TEXT NOT NULL,
          lang TEXT NOT NULL CHECK (lang IN ('ro','en','es','fr')),
          status TEXT NOT NULL CHECK (status IN ('pending_confirmation','confirmed','approved','rejected')),
          confirmation_token_hash TEXT NOT NULL,
          confirmation_expires_at TIMESTAMPTZ NOT NULL,
          confirmed_at TIMESTAMPTZ,
          consent_at TIMESTAMPTZ NOT NULL,
          ip_hash TEXT NOT NULL,
          moderation_notified_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS somatization_map_reviews_one_active_email
          ON somatization_map_reviews (email)
          WHERE status IN ('pending_confirmation','confirmed','approved');
        CREATE INDEX IF NOT EXISTS somatization_map_reviews_status_created
          ON somatization_map_reviews (status, created_at DESC);
      `).catch(error => {
        schemaPromise = null;
        logger.warn('[somatization-map-reviews] schema initialization failed');
        throw error;
      });
    }
    return schemaPromise;
  }

  function applyCors(req, res, methods = 'GET, POST, OPTIONS') {
    const origin = req.get('origin');
    if (!ALLOWED_ORIGINS.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return true;
  }

  function handleOptions(req, res) {
    if (!applyCors(req, res)) return res.status(403).json({ ok: false, error: 'forbidden' });
    return res.status(204).end();
  }

  function handlePublicOptions(req, res) {
    if (!applyCors(req, res, 'GET, OPTIONS')) return res.status(403).json({ ok: false, error: 'forbidden' });
    return res.status(204).end();
  }

  function limitHit(map, key, timestamp) {
    const active = (map.get(key) || []).filter(t => t > timestamp - RATE_WINDOW_MS);
    map.set(key, active);
    return active.length >= RATE_LIMIT;
  }

  function recordLimit(map, key, timestamp) {
    const list = map.get(key) || [];
    list.push(timestamp);
    map.set(key, list);
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

  function moderationSignature(id, action, expires) {
    const key = env.SOMATIZATION_MAP_REVIEW_HMAC_SECRET || env.SESSION_SECRET || '';
    if (!key) throw new Error('review_signing_key_unavailable');
    return crypto.createHmac('sha256', key).update(`${id}:${action}:${expires}`).digest('hex');
  }

  function moderationUrl(id, action, expires) {
    const sig = moderationSignature(id, action, expires);
    return `${baseUrl}/api/somatization-map/reviews/moderate?id=${encodeURIComponent(id)}&action=${action}&expires=${expires}&sig=${sig}`;
  }

  async function handleSubmit(req, res) {
    if (req.get('origin') && !applyCors(req, res, 'POST, OPTIONS')) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.website !== undefined && body.website !== null &&
        (typeof body.website !== 'string' || body.website.trim() !== '')) {
      return res.status(200).json({ ok: true });
    }

    const timestamp = now();
    const ipHash = hash(String(req.ip || req.socket?.remoteAddress || 'unknown'));
    pruneLimits(timestamp);
    if (limitHit(ipRequests, ipHash, timestamp)) return res.status(429).json({ ok: false, error: 'request_limit_reached' });
    recordLimit(ipRequests, ipHash, timestamp);

    const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const rating = body.rating;
    const reviewText = typeof body.text === 'string' ? body.text.trim() : '';
    const lang = body.lang === undefined ? 'en' : body.lang;
    if (firstName.length < 1 || firstName.length > 60 ||
        !EMAIL_RE.test(email) || email.length > 254 ||
        !Number.isInteger(rating) || rating < 1 || rating > 5 ||
        reviewText.length < 10 || reviewText.length > 800 ||
        !LANGUAGES.has(lang) || body.consent !== true) {
      return res.status(400).json({ ok: false, error: 'invalid_request' });
    }
    const emailHash = hash(email);
    if (limitHit(emailRequests, emailHash, timestamp)) return res.status(429).json({ ok: false, error: 'request_limit_reached' });
    recordLimit(emailRequests, emailHash, timestamp);

    const token = randomBytes(32).toString('hex');
    const tokenHash = hash(token);
    let insertedId = null;
    try {
      await ensureSchema();
      const inserted = await pool.query(
        `INSERT INTO somatization_map_reviews
          (first_name,email,rating,review_text,lang,status,confirmation_token_hash,
           confirmation_expires_at,consent_at,ip_hash)
         VALUES ($1,$2,$3,$4,$5,'pending_confirmation',$6,NOW()+INTERVAL '7 days',NOW(),$7)
         ON CONFLICT (email) WHERE status IN ('pending_confirmation','confirmed','approved') DO NOTHING
         RETURNING id`,
        [firstName, email, rating, reviewText, lang, tokenHash, ipHash]
      );
      if (!inserted.rows.length) return res.status(200).json({ ok: true });
      insertedId = inserted.rows[0].id;
      const confirmUrl = `${baseUrl}/api/somatization-map/reviews/confirm?token=${encodeURIComponent(token)}`;
      const copy = EMAIL_COPY[lang];
      const text = copy.body(confirmUrl);
      const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:560px;margin:auto"><p>${escapeHtml(text).replace(/\n\n/g, '</p><p>')}</p></div>`;
      const sent = await resend.emails.send({
        from: SENDER, replyTo: REPLY_TO, to: email, subject: copy.subject,
        text, html, _skipGlobalCooldown: true, _skipGlobalEmailLog: true
      });
      if (sent?.error) throw new Error('review_confirmation_send_failed');
      return res.status(200).json({ ok: true });
    } catch (error) {
      if (insertedId !== null) {
        await pool.query('DELETE FROM somatization_map_reviews WHERE id=$1 AND status=\'pending_confirmation\'', [insertedId]).catch(() => {});
      }
      logger.warn('[somatization-map-reviews] submission could not be completed');
      return res.status(error.message === 'review_confirmation_send_failed' ? 502 : 503)
        .json({ ok: false, error: 'temporarily_unavailable' });
    }
  }

  function confirmationPage(lang, message) {
    const copy = {
      ro: ['Recenzie confirmată', 'Recenzia va fi publicată doar după ce este citită și aprobată.'],
      en: ['Review confirmed', 'Your review will be published only after it has been read and approved.'],
      es: ['Reseña confirmada', 'Tu reseña solo se publicará después de leerla y aprobarla.'],
      fr: ['Avis confirmé', 'Votre avis ne sera publié qu’après lecture et approbation.']
    }[lang] || ['Review status', 'Your review will be published only after it has been read and approved.'];
    return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy[0]}</title><body style="font:16px Arial,sans-serif;max-width:600px;margin:12vh auto;padding:24px;color:#172033"><h1>${copy[0]}</h1><p>${message || copy[1]}</p></body></html>`;
  }

  async function handleConfirm(req, res) {
    const token = String(req.query?.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).send(confirmationPage('en', 'This confirmation link is invalid or expired.'));
    try {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE somatization_map_reviews SET status='confirmed',confirmed_at=NOW(),updated_at=NOW()
         WHERE confirmation_token_hash=$1 AND confirmation_expires_at>NOW()
           AND status='pending_confirmation'
         RETURNING id,first_name,email,rating,review_text,lang`,
        [hash(token)]
      );
      let review = result.rows[0];
      if (!review) {
        const existing = await pool.query(
          `SELECT id,first_name,email,rating,review_text,lang,status,moderation_notified_at
           FROM somatization_map_reviews
           WHERE confirmation_token_hash=$1 AND confirmation_expires_at>NOW()`,
          [hash(token)]
        );
        review = existing.rows[0];
        if (!review || !['confirmed', 'approved', 'rejected'].includes(review.status)) {
          return res.status(410).send(confirmationPage('en', 'This confirmation link is invalid or expired.'));
        }
        if (review.status !== 'confirmed' || review.moderation_notified_at) {
          return res.status(200).send(confirmationPage(review.lang));
        }
      }
      await sendModerationNotice(review);
      return res.status(200).send(confirmationPage(review.lang));
    } catch {
      logger.warn('[somatization-map-reviews] confirmation processing failed');
      return res.status(503).send(confirmationPage('en', 'Please try again later.'));
    }
  }

  async function sendModerationNotice(review) {
    const expires = Math.floor(now() / 1000) + 7 * 24 * 60 * 60;
    const approveUrl = moderationUrl(review.id, 'approve', expires);
    const rejectUrl = moderationUrl(review.id, 'reject', expires);
    const text = `New confirmed Somatization Map review\n\nName: ${review.first_name}\nRating: ${review.rating}/5\nLanguage: ${review.lang}\nEmail: ${review.email}\n\n${review.review_text}\n\nApprove: ${approveUrl}\nReject: ${rejectUrl}`;
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>New confirmed Somatization Map review</h2><p><b>Name:</b> ${escapeHtml(review.first_name)}<br><b>Rating:</b> ${review.rating}/5<br><b>Language:</b> ${escapeHtml(review.lang)}<br><b>Email:</b> ${escapeHtml(review.email)}</p><blockquote>${escapeHtml(review.review_text)}</blockquote><p><a href="${escapeHtml(approveUrl)}">Open approval page</a> · <a href="${escapeHtml(rejectUrl)}">Open rejection page</a></p></div>`;
    const sent = await resend.emails.send({
      from: SENDER, replyTo: REPLY_TO, to: REPLY_TO,
      subject: 'Somatization Map review awaiting moderation', text, html,
      _skipGlobalCooldown: true, _skipGlobalEmailLog: true
    });
    if (sent?.error) throw new Error('moderation_notice_send_failed');
    await pool.query(
      `UPDATE somatization_map_reviews SET moderation_notified_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND moderation_notified_at IS NULL`,
      [review.id]
    );
  }

  function validModerationSignature(id, action, expires, signature) {
    if (!['approve', 'reject'].includes(action) || !/^\d+$/.test(String(expires)) ||
        Number(expires) < Math.floor(now() / 1000)) return false;
    try {
      return safeEqual(moderationSignature(id, action, expires), signature);
    } catch {
      return false;
    }
  }

  function moderationForm(id, action, expires, signature, message = '') {
    const label = action === 'approve' ? 'Approve' : 'Reject';
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moderate review</title><body style="font:16px Arial,sans-serif;max-width:560px;margin:12vh auto;padding:24px;color:#172033"><h1>${label} review?</h1><p>${message || 'Confirm this moderation action. Opening this page does not change the review.'}</p><form method="post"><input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="expires" value="${escapeHtml(expires)}"><input type="hidden" name="sig" value="${escapeHtml(signature)}"><button style="padding:12px 20px;font-size:16px" type="submit">Confirm ${label.toLowerCase()}</button></form></body></html>`;
  }

  async function handleModerationGet(req, res) {
    const { id, action, expires, sig } = req.query || {};
    if (!validModerationSignature(String(id || ''), action, expires, sig)) return res.status(403).send('Invalid or expired moderation link.');
    return res.type('html').send(moderationForm(String(id), action, expires, sig));
  }

  async function handleModerationPost(req, res) {
    const { id, action, expires, sig } = req.body || {};
    if (!validModerationSignature(String(id || ''), action, expires, sig)) return res.status(403).send('Invalid or expired moderation link.');
    try {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE somatization_map_reviews SET status=$1,updated_at=NOW()
         WHERE id=$2 AND status='confirmed' RETURNING id`,
        [action === 'approve' ? 'approved' : 'rejected', id]
      );
      const text = result.rows.length ? 'Review moderation saved.' : 'This review is no longer awaiting moderation.';
      return res.status(200).type('html').send(moderationForm(id, action, expires, sig, text));
    } catch {
      logger.warn('[somatization-map-reviews] moderation update failed');
      return res.status(503).send('Moderation is temporarily unavailable.');
    }
  }

  async function handlePublicList(req, res) {
    if (req.get('origin') && !applyCors(req, res, 'GET, OPTIONS')) return res.status(403).json({ error: 'forbidden' });
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    try {
      await ensureSchema();
      const [items, stats] = await Promise.all([
        pool.query(
          `SELECT first_name,rating,review_text AS text,lang,created_at
           FROM somatization_map_reviews WHERE status='approved'
           ORDER BY created_at DESC LIMIT 200`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS count, COALESCE(AVG(rating),0)::float AS average
           FROM somatization_map_reviews WHERE status='approved'`
        )
      ]);
      return res.json({ reviews: items.rows, average: Number(stats.rows[0]?.average || 0), count: Number(stats.rows[0]?.count || 0) });
    } catch {
      logger.warn('[somatization-map-reviews] public list unavailable');
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  }

  async function handleDeleteByEmail(req, res) {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_request' });
    try {
      await ensureSchema();
      await pool.query('DELETE FROM somatization_map_reviews WHERE email=$1', [email]);
      return res.json({ ok: true });
    } catch {
      logger.warn('[somatization-map-reviews] deletion failed');
      return res.status(503).json({ ok: false, error: 'temporarily_unavailable' });
    }
  }

  async function cleanupExpired() {
    await ensureSchema();
    return pool.query(
      `DELETE FROM somatization_map_reviews
       WHERE (status='rejected' OR (status='pending_confirmation' AND confirmation_expires_at<=NOW()))
         AND created_at < NOW()-INTERVAL '30 days'`
    );
  }

  return {
    ensureSchema, handleOptions, handleSubmit, handleConfirm, handleModerationGet,
    handleModerationPost, handlePublicList, handlePublicOptions, handleDeleteByEmail, cleanupExpired
  };
}

module.exports = { createSomatizationMapReviewsService, ALLOWED_ORIGINS };
