'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyze } = require('../presend-local-analysis.js');

function check(result, title) {
  const found = result.checks.find(item => item.title === title);
  assert.ok(found, `Missing check: ${title}`);
  return found;
}

const problemSubject = 'Q2 Product Update!!! 🚨 ACT NOW';
const problemBody = [
  "We're excited to announce our #1 plan. Get 50% more responses in 2026, with a free trial for 8 days.",
  '{{first_name}}, click here: http://bit.ly/offer.',
  'Broken destination: https://example.com/broken.',
  'TODO: [insert proof]. Our report shows 50% growth for 42 teams.',
  'Our four-digit campaign code is 4712.',
  'The plan costs $29 per month. Use version 2.4.1, call 415-555-2671, and mail to 123 Main Street, New York, NY 19901.',
].join('\n\n');

test('problem-heavy message shows exact evidence and groups facts by type', () => {
  const result = analyze(problemSubject, problemBody);
  assert.deepEqual(result.linkUrls, ['http://bit.ly/offer', 'https://example.com/broken']);
  assert.equal(check(result, 'Subject line').status, 'review');
  assert.equal(check(result, 'First line and hook').status, 'review');
  assert.equal(check(result, 'Personalization and draft text').status, 'issue');
  assert.match(check(result, 'Personalization and draft text').found, /1 unresolved personalization variable/);
  assert.equal(check(result, 'CTAs and links').status, 'review');

  const dates = check(result, 'Facts to verify: dates and years').items.map(item => item.match);
  const stats = check(result, 'Facts to verify: statistics and figures').items.map(item => item.match);
  const percentages = check(result, 'Facts to verify: percentages');
  const prices = check(result, 'Facts to verify: prices');
  const durations = check(result, 'Facts to verify: durations and trials');
  const absolutes = check(result, 'Facts to verify: absolute claims');
  const codes = check(result, 'Codes and identifiers').items.map(item => item.match);

  assert.ok(dates.includes('2026'));
  assert.ok(!stats.includes('2026'), 'A year must not be classified as a standalone statistic');
  assert.ok(stats.includes('42'));
  assert.ok(percentages.items.some(item => item.match === '50%'));
  assert.ok(prices.items.some(item => item.match.includes('$29')));
  assert.ok(durations.items.some(item => item.match === '8 days'));
  assert.ok(absolutes.items.some(item => item.match === '#1'));
  assert.ok(codes.some(item => item.includes('19901')));
  assert.ok(codes.some(item => item.includes('415-555-2671')));
  assert.ok(codes.some(item => item.includes('2.4.1')));
  assert.ok(codes.some(item => item.includes('123 Main Street')));
  assert.ok(codes.some(item => item.includes('4712')));
  assert.ok(!codes.includes('#1'));
  assert.match(percentages.items[0].sentence, /Get 50% more responses in 2026/);
});

test('medium message highlights claims and generic copy for a second look', () => {
  const result = analyze(
    'Update: your onboarding summary',
    'I wanted to share a quick update. Our team reduced setup time by 18% across 42 teams last month. Learn more at https://example.com/guide. The release is planned for March 2026.'
  );
  assert.equal(check(result, 'Subject line').status, 'review');
  assert.equal(check(result, 'First line and hook').status, 'review');
  assert.equal(check(result, 'Facts to verify: percentages').items[0].match, '18%');
  assert.ok(check(result, 'Facts to verify: statistics and figures').items.some(item => item.match === '42'));
  assert.ok(check(result, 'Facts to verify: dates and years').items.some(item => item.match === '2026'));
  assert.ok(result.linkUrls.includes('https://example.com/guide'));
});

test('clean message passes basic copy checks without a numeric score', () => {
  const result = analyze(
    'Your report is ready',
    'Your requested report is ready. Open your report: https://example.com/report.\nUnsubscribe: https://example.com/unsubscribe.\nStrategic Flow, 123 Main Street, New York, NY 10001.'
  );
  const expectedPasses = [
    'Subject line',
    'First line and hook',
    'CTAs and links',
    'Reader focus',
    'Readability',
    'Spam-risk wording',
    'Personalization and draft text',
    'HTML images and layout',
    'Marketing email essentials',
    'Repetition and questions',
  ];
  for (const title of expectedPasses) assert.equal(check(result, title).status, 'passed', title);
  assert.equal(Object.hasOwn(result, 'score'), false);
});

test('HTML image metadata and empty link targets are flagged locally', () => {
  const result = analyze(
    'A short update',
    '<p>Hello there.</p><a href="#">Click here</a><img src="one.png"><img src="two.png" alt="Brand" width="120">'
  );
  assert.equal(check(result, 'HTML images and layout').status, 'issue');
  assert.equal(check(result, 'CTAs and links').status, 'issue');
  assert.equal(result.images.length, 2);
});
