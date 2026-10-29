'use strict';

const crypto = require('node:crypto');

const PACKS = Object.freeze({
  plink_1UVy37DpTwoDeZJnPhVDbxGW: {
    key: 'numdeep', name: 'Numerologie Deep', file: 'numdeep.sfpack', codeSecret: 'NUMEROLOGIE_CODE_NUMDEEP'
  },
  plink_1UVy38DpTwoDeZJnnWdw2gCL: {
    key: 'nlpdeep', name: 'NLP Deep', file: 'nlpdeep.sfpack', codeSecret: 'NUMEROLOGIE_CODE_NLPDEEP'
  },
  plink_1UVy38DpTwoDeZJnWJLPKySP: {
    key: 'crosspro', name: 'Profil încrucișat Pro', file: 'crosspro.sfpack', codeSecret: 'NUMEROLOGIE_CODE_CROSSPRO'
  },
  plink_1UVy39DpTwoDeZJnAJ7b59UP: {
    key: 'bundle', name: 'Bundle all three', file: 'bundle.sfpack', codeSecret: 'NUMEROLOGIE_CODE_BUNDLE'
  }
});
const DEFAULT_PACKS_BASE_URL = 'https://strategicflow.tech/numerologie-nlp/packs/';
const FROM = 'Strategic Flow <noreply@strategicflow.tech>';
const REPLY_TO = 'strategicflow@proton.me';
const TEST_RECIPIENTS = new Set(['consultantcalatorii@gmail.com', 'strategicflow@proton.me']);
const TEST_PACKS = new Set(['numdeep', 'nlpdeep', 'crosspro', 'bundle']);
const CODE_FORMAT_RE = /SFNN-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/;

function tokenMatches(expected, supplied) {
  if (!expected || !supplied) return false;
  const expectedDigest = crypto.createHash('sha256').update(String(expected)).digest();
  const suppliedDigest = crypto.createHash('sha256').update(String(supplied)).digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function safeErrorText(error, env) {
  let message = String(error?.message || error || 'Unknown delivery failure');
  for (const name of [
    'NUMEROLOGIE_TEST_TOKEN', 'NUMEROLOGIE_STRIPE_WEBHOOK_SECRET',
    'NUMEROLOGIE_CODE_NUMDEEP', 'NUMEROLOGIE_CODE_NLPDEEP',
    'NUMEROLOGIE_CODE_CROSSPRO', 'NUMEROLOGIE_CODE_BUNDLE'
  ]) {
    const secret = env[name];
    if (secret) message = message.split(String(secret)).join('[REDACTED]');
  }
  return message.slice(0, 1000);
}

function packForPaymentLink(paymentLink) {
  const id = typeof paymentLink === 'string' ? paymentLink : paymentLink?.id;
  return PACKS[id] || null;
}

function emailLanguage(locale, country) {
  const lang = String(locale || '').toLowerCase().split(/[-_]/)[0];
  if (lang === 'ro' || (!locale || lang === 'auto') && String(country || '').toUpperCase() === 'RO') return 'ro';
  if (lang === 'es' || (!locale || lang === 'auto') && String(country || '').toUpperCase() === 'ES') return 'es';
  return 'en';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function buildEmail(pack, activationCode, language, downloadUrl) {
  const copy = {
    ro: {
      subject: 'Pachetul tău Strategic Flow + codul de activare',
      thanks: 'Îți mulțumim pentru achiziție! Pachetul tău este pregătit.',
      code: 'Codul tău de activare',
      steps: ['Deschide https://strategicflow.tech/numerologie-nlp/.', 'Mergi la „Contul meu”, apoi „Pachete”.', 'Încarcă fișierul atașat și introdu codul de mai sus.'],
      backup: 'Link de descărcare de rezervă',
      offline: 'Fișierul funcționează și offline. Răspunde la acest email dacă ai nevoie de ajutor.'
    },
    es: {
      subject: 'Tu paquete de Strategic Flow y tu código de activación',
      thanks: '¡Gracias por tu compra! Tu paquete está listo.',
      code: 'Tu código de activación',
      steps: ['Abre https://strategicflow.tech/numerologie-nlp/.', 'Ve a «Mi perfil» y después a «Paquetes».', 'Carga el archivo adjunto e introduce el código.'],
      backup: 'Enlace de descarga alternativo',
      offline: 'El archivo también funciona sin conexión. Responde a este correo si necesitas ayuda.'
    },
    en: {
      subject: 'Your Strategic Flow pack and activation code',
      thanks: 'Thank you for your purchase! Your pack is ready.',
      code: 'Your activation code',
      steps: ['Open https://strategicflow.tech/numerologie-nlp/.', 'Go to “My profile”, then “Packs”.', 'Load the attached file and enter the code above.'],
      backup: 'Backup download link',
      offline: 'The file also works offline. Reply to this email if you need help.'
    }
  }[language];
  const text = [
    copy.thanks, '', `Pack: ${pack.name}`, `${copy.code}: ${activationCode}`, '',
    `1. ${copy.steps[0]}`, `2. ${copy.steps[1]}`, `3. ${copy.steps[2]}`, '',
    `${copy.backup}: ${downloadUrl}`, '', copy.offline
  ].join('\n');
  const html = `<div style="margin:0;background:#081426;padding:24px 12px;color:#f7f4ed;font-family:Arial,sans-serif"><div style="max-width:520px;margin:auto;background:#10213a;border:1px solid #b99755;padding:28px 24px;border-radius:12px"><p style="color:#c5a45e;font-size:12px;letter-spacing:.12em;text-transform:uppercase">Strategic Flow</p><h1 style="font-size:22px;line-height:1.35;color:#f3d68a">${escapeHtml(pack.name)}</h1><p style="font-size:16px;line-height:1.6">${escapeHtml(copy.thanks)}</p><p style="color:#d7bd78">${escapeHtml(copy.code)}</p><p style="font-size:20px;font-weight:bold;letter-spacing:.08em;background:#081426;padding:14px;border-radius:6px;overflow-wrap:anywhere">${escapeHtml(activationCode)}</p><ol style="padding-left:22px;line-height:1.8">${copy.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol><p><a style="color:#f3d68a;overflow-wrap:anywhere" href="${escapeHtml(downloadUrl)}">${escapeHtml(copy.backup)}</a></p><p style="font-size:14px;line-height:1.6;color:#cbd5e1">${escapeHtml(copy.offline)}</p></div></div>`;
  return { subject: copy.subject, text, html };
}

function createNumerologieDeliveryService({ pool, resend, stripe, env = process.env, fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const packCache = new Map();
  const activeDeliveries = new Set();

  async function downloadPack(pack) {
    if (packCache.has(pack.file)) return packCache.get(pack.file);
    const base = env.NUMEROLOGIE_PACKS_BASE_URL || DEFAULT_PACKS_BASE_URL;
    const url = new URL(encodeURIComponent(pack.file), base.endsWith('/') ? base : `${base}/`);
    if (url.protocol !== 'https:') throw new Error('Pack base URL must use HTTPS');
    const response = await fetchImpl(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`Pack download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('Pack file is empty or exceeds the 25 MB limit');
    packCache.set(pack.file, bytes);
    return bytes;
  }

  function getActivationCode(pack) {
    const code = env[pack.codeSecret];
    if (!code || !String(code).trim()) throw new Error(`Missing secret ${pack.codeSecret}`);
    return String(code).trim();
  }

  async function prepareBuyerEmail(delivery) {
    const pack = Object.values(PACKS).find(item => item.key === delivery.pack);
    if (!pack) throw new Error(`Unknown pack ${delivery.pack}`);
    let code;
    try {
      code = getActivationCode(pack);
    } catch (err) {
      err.deliveryFailure = 'missing_code';
      throw err;
    }
    let bytes;
    try {
      bytes = await downloadPack(pack);
    } catch (err) {
      err.deliveryFailure = 'missing_file';
      throw err;
    }
    const downloadUrl = new URL(encodeURIComponent(pack.file), (env.NUMEROLOGIE_PACKS_BASE_URL || DEFAULT_PACKS_BASE_URL).endsWith('/')
      ? (env.NUMEROLOGIE_PACKS_BASE_URL || DEFAULT_PACKS_BASE_URL)
      : `${env.NUMEROLOGIE_PACKS_BASE_URL || DEFAULT_PACKS_BASE_URL}/`).toString();
    const language = emailLanguage(delivery.locale, delivery.billing_country);
    const email = buildEmail(pack, code, language, downloadUrl);
    return {
      pack, bytes, language, email,
      codeFormatPresent: CODE_FORMAT_RE.test(email.text)
    };
  }

  async function sendBuyerEmail(delivery, prepared = null) {
    const content = prepared || await prepareBuyerEmail(delivery);
    const result = await resend.emails.send({
      from: FROM, replyTo: REPLY_TO, to: delivery.buyer_email, subject: content.email.subject,
      html: content.email.html, text: content.email.text,
      attachments: [{ filename: content.pack.file, content: content.bytes.toString('base64') }]
    }, { idempotencyKey: `numerologie-${delivery.checkout_session_id}-${new Date(delivery.updated_at).getTime()}` });
    if (result?.error) throw new Error(result.error.message || 'Resend rejected the email');
    return {
      resendMessageId: result?.data?.id || null,
      attachmentFilename: content.pack.file,
      attachmentSizeBytes: content.bytes.length,
      language: content.language,
      codeFormatPresent: content.codeFormatPresent
    };
  }

  async function sendAlert(delivery, error) {
    try {
      const result = await resend.emails.send({
        from: FROM, to: REPLY_TO, replyTo: REPLY_TO,
        subject: `Numerologie pack delivery failed: ${delivery.pack}`,
        text: `Delivery failed.\nBuyer: ${delivery.buyer_email}\nPack: ${delivery.pack}\nError: ${safeErrorText(error, env)}`
      });
      if (result?.error) console.error('[numerologie-delivery] failure alert rejected');
    } catch (alertError) {
      console.error('[numerologie-delivery] failure alert could not be sent:', safeErrorText(alertError, env));
    }
  }

  async function deliverStoredRow(delivery) {
    let prepared = null;
    let result = null;
    let lastError = null;
    try {
      prepared = await prepareBuyerEmail(delivery);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await sendBuyerEmail(delivery, prepared);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < 3) await sleep(attempt * 1000);
        }
      }
    } catch (err) {
      lastError = err;
    }

    if (!lastError) {
      await pool.query(
        `UPDATE numerologie_deliveries
         SET status='sent', resend_message_id=$2, error_message=NULL, sent_at=NOW(), updated_at=NOW()
         WHERE id=$1`,
        [delivery.id, result.resendMessageId]
      );
      return { ...result, status: 'sent' };
    }

    const safeError = safeErrorText(lastError, env);
    await pool.query(
      `UPDATE numerologie_deliveries SET status='failed', error_message=$2, updated_at=NOW() WHERE id=$1`,
      [delivery.id, safeError]
    );
    await sendAlert(delivery, new Error(safeError));
    const pack = Object.values(PACKS).find(item => item.key === delivery.pack);
    const language = emailLanguage(delivery.locale, delivery.billing_country);
    return {
      status: lastError.deliveryFailure === 'missing_code'
        ? 'failed_missing_code'
        : lastError.deliveryFailure === 'missing_file' ? 'failed_missing_file' : 'failed',
      resendMessageId: null,
      attachmentFilename: pack?.file || null,
      attachmentSizeBytes: 0,
      language,
      codeFormatPresent: false
    };
  }

  async function processDelivery(id) {
    if (activeDeliveries.has(id)) return;
    activeDeliveries.add(id);
    let delivery;
    try {
      const claim = await pool.query(
        `UPDATE numerologie_deliveries SET status='sending', updated_at=NOW()
         WHERE id=$1 AND status IN ('pending','failed')
         RETURNING *`, [id]
      );
      if (!claim.rows.length) return;
      delivery = claim.rows[0];
      return await deliverStoredRow(delivery);
    } catch (err) {
      console.error('[numerologie-delivery] processing error:', safeErrorText(err, env));
      if (delivery) {
        await pool.query(`UPDATE numerologie_deliveries SET status='failed', error_message=$2, updated_at=NOW() WHERE id=$1`, [id, safeErrorText(err, env)]).catch(() => {});
        await sendAlert(delivery, err);
      }
      return { status: 'failed', resendMessageId: null, attachmentFilename: null, attachmentSizeBytes: 0, language: emailLanguage(delivery?.locale, delivery?.billing_country), codeFormatPresent: false };
    } finally {
      activeDeliveries.delete(id);
    }
  }

  function enqueue(id) {
    setImmediate(() => { void processDelivery(id); });
  }

  async function handleWebhook(req, res) {
    const secret = env.NUMEROLOGIE_STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).send('Numerologie webhook secret is not configured');
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), secret);
    } catch (err) {
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      return res.status(200).json({ received: true, ignored: true });
    }
    const session = event.data?.object;
    if (event.type === 'checkout.session.completed' && session?.payment_status !== 'paid') {
      return res.status(200).json({ received: true, ignored: true });
    }
    if (event.type === 'checkout.session.async_payment_succeeded' && session?.payment_status !== 'paid') {
      return res.status(200).json({ received: true, ignored: true });
    }
    const pack = packForPaymentLink(session?.payment_link);
    if (!pack) return res.status(200).json({ received: true, ignored: true });
    const buyerEmail = String(session?.customer_details?.email || '').trim().toLowerCase();
    if (!buyerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
      return res.status(200).json({ received: true, ignored: true });
    }
    try {
      const inserted = await pool.query(
        `INSERT INTO numerologie_deliveries
          (stripe_event_id, checkout_session_id, buyer_email, pack, status, locale, billing_country)
         VALUES ($1,$2,$3,$4,'pending',$5,$6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [event.id, session.id, buyerEmail, pack.key, session.locale || null, session.customer_details?.address?.country || null]
      );
      if (inserted.rows[0]) enqueue(inserted.rows[0].id);
      return res.status(200).json({ received: true, queued: Boolean(inserted.rows[0]) });
    } catch (err) {
      console.error('[numerologie-delivery] could not store paid checkout:', err.message);
      return res.status(503).json({ error: 'delivery_queue_unavailable' });
    }
  }

  async function retryPending() {
    try {
      const result = await pool.query(
        `SELECT id, status FROM numerologie_deliveries
         WHERE status='pending' OR (status='sending' AND updated_at < NOW() - INTERVAL '15 minutes')
         ORDER BY created_at ASC LIMIT 20`
      );
      for (const row of result.rows) {
        if (activeDeliveries.has(row.id)) continue;
        if (row.status === 'sending') await pool.query(
          `UPDATE numerologie_deliveries SET status='pending', updated_at=NOW() WHERE id=$1 AND status='sending'`, [row.id]
        );
        enqueue(row.id);
      }
    } catch (err) {
      if (err.code !== '42P01') console.error('[numerologie-delivery] queue scan failed:', err.message);
    }
  }

  async function runTestDeliveries({ to, packKeys, language, allowAnyRecipient = false }) {
    const normalizedEmail = String(to || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      const err = new Error('Invalid test email');
      err.code = 'invalid_email';
      throw err;
    }
    if (!allowAnyRecipient && !TEST_RECIPIENTS.has(normalizedEmail)) {
      const err = new Error('Recipient is not allowed for test delivery');
      err.code = 'recipient_not_allowed';
      throw err;
    }
    if (!Array.isArray(packKeys) || !packKeys.length || packKeys.some(key => !TEST_PACKS.has(key))) {
      const err = new Error('Invalid test pack');
      err.code = 'invalid_pack';
      throw err;
    }
    if (language !== undefined && !['ro', 'es', 'en'].includes(language)) {
      const err = new Error('Invalid test language');
      err.code = 'invalid_language';
      throw err;
    }

    const client = await pool.connect();
    const rows = [];
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('numerologie-test-delivery-rate-limit'))`);
      const count = await client.query(
        `SELECT COUNT(*)::int AS sends
         FROM numerologie_test_send_attempts
         WHERE created_at > NOW() - INTERVAL '1 hour'`
      );
      if (Number(count.rows[0]?.sends || 0) + packKeys.length > 10) {
        await client.query('ROLLBACK');
        const err = new Error('Hourly test delivery limit reached');
        err.code = 'rate_limited';
        throw err;
      }
      for (const packKey of packKeys) {
        const id = crypto.randomUUID();
        const inserted = await client.query(
          `INSERT INTO numerologie_deliveries
            (stripe_event_id, checkout_session_id, buyer_email, pack, status, locale, is_test)
           VALUES ($1,$2,$3,$4,'sending',$5,TRUE) RETURNING *`,
          [`test_${id}`, `test_${id}`, normalizedEmail, packKey, language || null]
        );
        const row = inserted.rows[0];
        rows.push(row);
        await client.query(
          `INSERT INTO numerologie_test_send_attempts (delivery_id) VALUES ($1)`,
          [row.id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const results = [];
    for (const row of rows) {
      activeDeliveries.add(row.id);
      try {
        results.push({ pack: row.pack, ...(await deliverStoredRow(row)) });
      } finally {
        activeDeliveries.delete(row.id);
      }
    }
    return results;
  }

  async function sendTestDeliveries(args) {
    return runTestDeliveries(args);
  }

  async function sendAdminTest(to, packKey) {
    const results = await runTestDeliveries({ to, packKeys: [packKey], language: 'ro', allowAnyRecipient: true });
    return results[0];
  }

  async function queueResend(id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rowResult = await client.query(
        `SELECT id, is_test, status FROM numerologie_deliveries WHERE id=$1 FOR UPDATE`,
        [id]
      );
      const row = rowResult.rows[0];
      if (!row || row.status === 'sending') {
        await client.query('ROLLBACK');
        return { queued: false, reason: 'not_available' };
      }
      if (row.is_test) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('numerologie-test-delivery-rate-limit'))`);
        const count = await client.query(
          `SELECT COUNT(*)::int AS sends FROM numerologie_test_send_attempts
           WHERE created_at > NOW() - INTERVAL '1 hour'`
        );
        if (Number(count.rows[0]?.sends || 0) >= 10) {
          await client.query('ROLLBACK');
          return { queued: false, reason: 'rate_limited' };
        }
        await client.query(`INSERT INTO numerologie_test_send_attempts (delivery_id) VALUES ($1)`, [id]);
      }
      await client.query(
        `UPDATE numerologie_deliveries
         SET status='pending', error_message=NULL, sent_at=NULL, updated_at=NOW()
         WHERE id=$1`,
        [id]
      );
      await client.query('COMMIT');
      return { queued: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { handleWebhook, processDelivery, retryPending, sendTestDeliveries, sendAdminTest, queueResend };
}

module.exports = {
  PACKS, TEST_RECIPIENTS, packForPaymentLink, emailLanguage, buildEmail,
  tokenMatches, createNumerologieDeliveryService
};
