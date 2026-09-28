'use strict';

async function submitDirectoryListingTransaction(pool, {
  cleanUrl,
  name,
  category,
  description,
  normalizedEmail,
  suppliedLogo
}) {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    // Production has legacy directory_listings tables without a unique URL
    // constraint, so serialize duplicate checks by normalized URL.
    const normalizedUrlKey = cleanUrl.toLowerCase().replace(/\/+$/, '');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`directory-submit-url:${normalizedUrlKey}`]
    );
    const existing = await client.query(
      `SELECT id FROM directory_listings
       WHERE regexp_replace(lower(url), '/+$', '')=$1
       LIMIT 1`,
      [normalizedUrlKey]
    );

    if (existing.rows.length) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { duplicate: true };
    }

    const result = await client.query(
      `INSERT INTO directory_listings (name, url, category, description, submitter_email, image_url, score_pending, status)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE,'active') RETURNING id`,
      [
        (name || '').trim().slice(0, 80),
        cleanUrl.slice(0, 300),
        (category || 'General').slice(0, 40),
        (description || '').trim().slice(0, 300),
        normalizedEmail || null,
        suppliedLogo
      ]
    );

    await client.query('COMMIT');
    transactionOpen = false;
    return { duplicate: false, id: result.rows[0].id };
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { submitDirectoryListingTransaction };