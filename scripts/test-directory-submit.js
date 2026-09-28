'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { submitDirectoryListingTransaction } = require('../directory-submit-transaction');

function makePool({ existingRows = [], failOnQuery = '' } = {}) {
  const state = { released: 0, queries: [] };
  const client = {
    async query(sql) {
      const text = typeof sql === 'string' ? sql : sql.text;
      state.queries.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (failOnQuery && text.includes(failOnQuery)) {
        throw new Error('simulated query failure');
      }
      if (text.includes('SELECT id FROM directory_listings')) {
        return { rows: existingRows };
      }
      if (text.includes('INSERT INTO directory_listings')) {
        return { rows: [{ id: 42 }] };
      }
      return { rows: [] };
    },
    release() {
      state.released++;
    }
  };

  return {
    state,
    pool: {
      async connect() {
        return client;
      }
    }
  };
}

const submission = {
  cleanUrl: 'https://example.test/',
  name: 'Example',
  category: 'SaaS',
  description: 'A test product',
  normalizedEmail: 'founder@example.test',
  suppliedLogo: null
};

test('duplicate submission commits and releases the checked-out client', async () => {
  const { pool, state } = makePool({ existingRows: [{ id: 7 }] });

  const result = await submitDirectoryListingTransaction(pool, submission);

  assert.deepEqual(result, { duplicate: true });
  assert.equal(state.queries.at(-1), 'COMMIT');
  assert.equal(state.queries.some(query => query.startsWith('INSERT INTO')), false);
  assert.equal(state.released, 1);
});

test('new submission commits and releases the checked-out client', async () => {
  const { pool, state } = makePool();

  const result = await submitDirectoryListingTransaction(pool, submission);

  assert.deepEqual(result, { duplicate: false, id: 42 });
  assert.equal(state.queries.at(-1), 'COMMIT');
  assert.equal(state.released, 1);
});

test('failed submission rolls back and releases the checked-out client', async () => {
  const { pool, state } = makePool({ failOnQuery: 'SELECT id FROM directory_listings' });

  await assert.rejects(
    submitDirectoryListingTransaction(pool, submission),
    /simulated query failure/
  );

  assert.equal(state.queries.at(-1), 'ROLLBACK');
  assert.equal(state.released, 1);
});