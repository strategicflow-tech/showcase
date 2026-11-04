'use strict';

const PROGRAM_URLS = Object.freeze({
  p1: 'https://strategicflow.tech/somatization-map/programs/emotions-c3d6584cd65d/',
  p2: 'https://strategicflow.tech/somatization-map/programs/anger-110b71d11189/',
  p3: 'https://strategicflow.tech/somatization-map/programs/sadness-c3dfe3f19699/',
  p4: 'https://strategicflow.tech/somatization-map/programs/stress-87db5692feef/',
  pack: 'https://strategicflow.tech/somatization-map/programs/pack-03e1f052d749/'
});

const SENDER = 'Somatization Map <noreply@strategicflow.tech>';
const REPLY_TO = 'strategicflow@proton.me';

function buildEmail(programUrl) {
  const blocks = [
    `EN — Thank you for your purchase. Your Somatization Map program: ${programUrl}. This content is educational and is not medical advice.`,
    `RO — Îți mulțumim pentru achiziție. Programul tău Somatization Map: ${programUrl}. Conținutul este educațional și nu reprezintă sfat medical.`,
    `ES — Gracias por tu compra. Tu programa Somatization Map: ${programUrl}. Este contenido es educativo y no constituye consejo médico.`,
    `FR — Merci pour votre achat. Votre programme Somatization Map : ${programUrl}. Ce contenu est éducatif et ne constitue pas un avis médical.`
  ];
  return {
    subject: 'Your Somatization Map program',
    text: blocks.join('\n\n'),
    html: `<div data-readable-email="v2" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#172033;line-height:1.6"><p>${blocks[0]}</p><p>${blocks[1]}</p><p>${blocks[2]}</p><p>${blocks[3]}</p></div>`
  };
}

function createSomatizationMapWebhook({ pool, resend, stripe, env = process.env, logger = console }) {
  async function handleWebhook(req, res) {
    const secret = env.STRIPE_SOMATIZATION_WEBHOOK_SECRET;
    if (!secret) return res.status(503).send('Somatization Map webhook secret is not configured');

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), secret);
    } catch {
      logger.warn('[somatization-map-webhook] signature verification failed');
      return res.status(400).send('Webhook signature verification failed');
    }

    if (event.type !== 'checkout.session.completed') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const session = event.data?.object;
    const metadata = session?.metadata || {};
    if (metadata.project !== 'somatization-map') {
      return res.status(200).json({ received: true, ignored: true });
    }
    const programUrl = PROGRAM_URLS[metadata.program];
    if (!programUrl || session.payment_status !== 'paid') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const email = String(session.customer_details?.email || '').trim().toLowerCase();
    if (!session.id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      logger.error('[somatization-map-webhook] eligible checkout is missing required delivery data');
      return res.status(200).json({ received: true, ignored: true });
    }

    let inserted;
    try {
      inserted = await pool.query(
        `INSERT INTO somatization_map_deliveries
           (checkout_session_id, stripe_event_id, program, status)
         VALUES ($1,$2,$3,'sending')
         ON CONFLICT (checkout_session_id) DO NOTHING
         RETURNING checkout_session_id`,
        [session.id, event.id, metadata.program]
      );
    } catch {
      logger.error('[somatization-map-webhook] unable to record checkout');
      return res.status(503).json({ error: 'delivery_record_unavailable' });
    }

    if (!inserted.rows.length) return res.status(200).json({ received: true, duplicate: true });

    try {
      const content = buildEmail(programUrl);
      const result = await resend.emails.send({
        from: SENDER,
        replyTo: REPLY_TO,
        to: email,
        subject: content.subject,
        text: content.text,
        html: content.html,
        _skipGlobalCooldown: true,
        _skipGlobalEmailLog: true
      });
      if (result?.error) throw new Error('resend_send_failed');
      await pool.query(
        `UPDATE somatization_map_deliveries
         SET status='sent', resend_message_id=$2, updated_at=NOW()
         WHERE checkout_session_id=$1`,
        [session.id, result?.data?.id || null]
      );
      return res.status(200).json({ received: true, delivered: true });
    } catch {
      await pool.query(
        `UPDATE somatization_map_deliveries
         SET status='failed', failure_code='email_send_failed', updated_at=NOW()
         WHERE checkout_session_id=$1`,
        [session.id]
      ).catch(() => {});
      logger.error('[somatization-map-webhook] email delivery failed');
      return res.status(200).json({ received: true, delivered: false });
    }
  }

  return { handleWebhook };
}

module.exports = { PROGRAM_URLS, SENDER, REPLY_TO, buildEmail, createSomatizationMapWebhook };
