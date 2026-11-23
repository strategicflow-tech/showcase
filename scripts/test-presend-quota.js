'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { WEEKLY_LIMIT, WEEKLY_WINDOW_MS, createPresendQuotaService } = require('../presend-weekly-quota');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the pre-send quota integration test.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let clock = new Date();
  const testIp = `presend-quota-test-${crypto.randomUUID()}`;
  const testSalt = crypto.randomBytes(32).toString('hex');
  const service = createPresendQuotaService({
    pool,
    hashSalt: testSalt,
    now: () => clock,
  });
  const restartedService = createPresendQuotaService({
    pool,
    hashSalt: testSalt,
    now: () => clock,
  });
  const ipHash = service.hashIp(testIp);

  try {
    const tokens = [];
    for (let index = 0; index < WEEKLY_LIMIT; index += 1) {
      const result = await service.reserve(testIp);
      assert.equal(result.allowed, true, `check ${index + 1} should be allowed`);
      assert.equal(result.remaining, WEEKLY_LIMIT - index - 1);
      tokens.push(result.checkToken);
    }

    const redeemed = await restartedService.consumeReservation(testIp, tokens[0]);
    assert.equal(redeemed.allowed, true, 'a reservation should survive service recreation');
    assert.equal((await restartedService.consumeReservation(testIp, tokens[0])).allowed, false, 'a reservation must not be reusable');

    const blocked = await restartedService.reserve(testIp);
    assert.equal(blocked.allowed, false, 'the eleventh check must be blocked across service instances');
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.resetAt, new Date(clock.getTime() + WEEKLY_WINDOW_MS).toISOString());

    const stored = await pool.query(
      `SELECT COUNT(*)::int AS count, MIN(ip_hash) AS ip_hash
       FROM presend_weekly_check_events
       WHERE ip_hash = $1 AND created_at >= $2`,
      [ipHash, new Date(clock.getTime() - WEEKLY_WINDOW_MS)]
    );
    assert.equal(stored.rows[0].count, WEEKLY_LIMIT);
    assert.equal(stored.rows[0].ip_hash, ipHash);
    assert.equal(stored.rows[0].ip_hash.includes(testIp), false, 'the database must store only the keyed IP hash');

    clock = new Date(clock.getTime() + WEEKLY_WINDOW_MS + 1);
    const afterWindow = await restartedService.reserve(testIp);
    assert.equal(afterWindow.allowed, true, 'a check should be allowed after the seven-day window');
    assert.equal(afterWindow.remaining, 9);
    const remainingRows = await pool.query(
      'SELECT COUNT(*)::int AS count FROM presend_weekly_check_events WHERE ip_hash = $1',
      [ipHash]
    );
    assert.equal(remainingRows.rows[0].count, 1, 'expired rows should be removed automatically during a new check');
    console.log('Pre-send quota integration passed: 10 allowed, 11th blocked, one-time token, restart persistence, 7-day reset, and expired-row cleanup.');
  } finally {
    await pool.query('DELETE FROM presend_weekly_check_events WHERE ip_hash = $1', [ipHash]).catch(() => {});
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
