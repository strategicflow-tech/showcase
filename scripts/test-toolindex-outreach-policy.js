const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedOutreachTarget } = require('../outreach-policy');

const manuallyExcludedCompanies = [
  '1stDibs',
  'Unity Technologies',
  'Wolters Kluwer Australia',
  'MyFitnessPal',
  'MasterClass',
  'AllTrails',
  'Jama Software',
];

test('manually excluded large companies are blocked from outreach', () => {
  for (const company of manuallyExcludedCompanies) {
    const result = isBlockedOutreachTarget(company, 'contact@example.test');
    assert.equal(result.blocked, true, `${company} should be blocked`);
    assert.match(result.reason, /large\/established company/);
  }
});

test('an unrelated small company remains eligible for outreach', () => {
  assert.deepEqual(
    isBlockedOutreachTarget('Small Example Startup', 'contact@example.test'),
    { blocked: false }
  );
});