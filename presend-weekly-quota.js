'use strict';

const crypto = require('crypto');

const WEEKLY_LIMIT = 10;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TABLE_NAME = 'presend_weekly_check_events';

function createPresendQuotaService({ pool, hashSalt, now = () => new Date() } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('A PostgreSQL pool is required for the pre-send quota.');
  }
  if (typeof hashSalt !== 'string' || !hashSalt.trim()) {
    throw new Error('A secret HMAC key is required for the pre-send quota.');
  }

  function currentTime() {
    const value = now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('The pre-send quota clock returned an invalid time.');
    return date;
  }

  function hashIp(ipAddress) {
    const normalizedIp = String(ipAddress || '').trim().toLowerCase();
    if (!normalizedIp || normalizedIp === 'unknown') {
      throw new Error('A client IP address is required for the pre-send quota.');
    }
    return crypto
      .createHmac('sha256', hashSalt)
      .update(`presend-ip:v1:${normalizedIp}`)
      .digest('hex');
  }

  function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  function getResetAt(oldest, time) {
    const firstCheck = oldest ? new Date(oldest) : time;
    return new Date(firstCheck.getTime() + WEEKLY_WINDOW_MS).toISOString();
  }

  async function lockIp(client, ipHash) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ipHash]);
  }

  async function cleanupExpiredWith(client, time, ipHash) {
    const cutoff = new Date(time.getTime() - WEEKLY_WINDOW_MS);
    await client.query(
      `DELETE FROM ${TABLE_NAME} WHERE created_at < NOW() - INTERVAL '7 days'`
    );
    const result = await client.query(
      `DELETE FROM ${TABLE_NAME} WHERE created_at < $1 AND ip_hash = $2`,
      [cutoff, ipHash]
    );
    return result.rowCount || 0;
  }

  async function readUsage(client, ipHash, time) {
    const cutoff = new Date(time.getTime() - WEEKLY_WINDOW_MS);
    const result = await client.query(
      `SELECT COUNT(*)::int AS used, MIN(created_at) AS oldest
       FROM ${TABLE_NAME}
       WHERE ip_hash = $1 AND created_at >= $2`,
      [ipHash, cutoff]
    );
    return {
      used: Number(result.rows[0]?.used || 0),
      oldest: result.rows[0]?.oldest || null,
    };
  }

  async function reserve(ipAddress) {
    const ipHash = hashIp(ipAddress);
    const time = currentTime();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockIp(client, ipHash);
      await cleanupExpiredWith(client, time, ipHash);
      const usage = await readUsage(client, ipHash, time);
      if (usage.used >= WEEKLY_LIMIT) {
        await client.query('COMMIT');
        return {
          allowed: false,
          remaining: 0,
          resetAt: getResetAt(usage.oldest, time),
        };
      }

      await client.query(
        `INSERT INTO ${TABLE_NAME} (id, ip_hash, token_hash, created_at)
         VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), ipHash, tokenHash, time]
      );
      const used = usage.used + 1;
      const oldest = usage.oldest || time;
      await client.query('COMMIT');
      return {
        allowed: true,
        remaining: WEEKLY_LIMIT - used,
        resetAt: getResetAt(oldest, time),
        checkToken: token,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function consumeReservation(ipAddress, token) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 100) {
      return { allowed: false, reason: 'invalid_token' };
    }
    const ipHash = hashIp(ipAddress);
    const time = currentTime();
    const cutoff = new Date(time.getTime() - WEEKLY_WINDOW_MS);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockIp(client, ipHash);
      await cleanupExpiredWith(client, time, ipHash);
      const redeemed = await client.query(
        `UPDATE ${TABLE_NAME}
         SET token_used_at = $1
         WHERE ip_hash = $2
           AND token_hash = $3
           AND token_used_at IS NULL
           AND created_at >= $4
         RETURNING created_at`,
        [time, ipHash, hashToken(token), cutoff]
      );
      if (!redeemed.rows.length) {
        await client.query('COMMIT');
        return { allowed: false, reason: 'invalid_token' };
      }

      const usage = await readUsage(client, ipHash, time);
      await client.query('COMMIT');
      return {
        allowed: true,
        remaining: Math.max(0, WEEKLY_LIMIT - usage.used),
        resetAt: getResetAt(usage.oldest, time),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function cleanupExpired() {
    const time = currentTime();
    const cutoff = new Date(time.getTime() - WEEKLY_WINDOW_MS);
    const result = await pool.query(
      `DELETE FROM ${TABLE_NAME} WHERE created_at < $1`,
      [cutoff]
    );
    return result.rowCount || 0;
  }

  return { hashIp, reserve, consumeReservation, cleanupExpired };
}

module.exports = {
  WEEKLY_LIMIT,
  WEEKLY_WINDOW_MS,
  createPresendQuotaService,
};
