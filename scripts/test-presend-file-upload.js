'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseEmailFile } = require('../presend-file-upload.js');
const { analyze } = require('../presend-local-analysis.js');

const htmlBody = '<html><body><p>HTML body</p></body></html>';
const textBody = 'Plain text body for a local email check.';
const htmlEncoded = Buffer.from('<html><body><p>HTML café version</p></body></html>', 'utf8').toString('base64');
const multipartEmail = [
  'From: sender@example.test',
  'Subject: =?UTF-8?Q?MIME_=E2=9C=93?=',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="email-boundary"',
  '',
  '--email-boundary',
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Plain version with caf=C3=A9.',
  '--email-boundary',
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: base64',
  '',
  htmlEncoded,
  '--email-boundary--',
  '',
].join('\r\n');

test('HTML, HTM, and TXT uploads preserve their local body content', () => {
  assert.equal(parseEmailFile('message.html', htmlBody).body, htmlBody);
  assert.equal(parseEmailFile('message.htm', htmlBody).body, htmlBody);
  assert.equal(parseEmailFile('message.txt', textBody).body, textBody);
  assert.equal(parseEmailFile('message.txt', textBody).hasTextAlternative, false);
});

test('multipart EML decodes subject, quoted-printable text, and base64 HTML', () => {
  const parsed = parseEmailFile('message.eml', multipartEmail);
  assert.equal(parsed.subject, 'MIME ✓');
  assert.match(parsed.body, /HTML café version/);
  assert.doesNotMatch(parsed.body, /Plain version/);
  assert.equal(parsed.hasTextAlternative, true);
});

test('multipart EML text alternative resolves the analyzer check', () => {
  const parsed = parseEmailFile('message.eml', multipartEmail);
  const result = analyze(parsed.subject, parsed.body, { hasTextAlternative: parsed.hasTextAlternative });
  const htmlCheck = result.checks.find(item => item.title === 'HTML images and layout');
  assert.equal(htmlCheck.status, 'passed');
  assert.match(htmlCheck.found, /uploaded EML included a text\/plain alternative/);
});

test('EML with only quoted-printable plain text falls back to text/plain', () => {
  const plainEmail = [
    'Subject: Plain fallback',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary=plain-boundary',
    '',
    '--plain-boundary',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'A plain message with na=C3=AFve text.',
    '--plain-boundary--',
    '',
  ].join('\n');
  const parsed = parseEmailFile('plain.eml', plainEmail);
  assert.equal(parsed.subject, 'Plain fallback');
  assert.equal(parsed.body.trim(), 'A plain message with naïve text.');
  assert.equal(parsed.hasTextAlternative, false);
});

test('unsupported extensions fail with a clear format message', () => {
  assert.throws(
    () => parseEmailFile('message.pdf', 'not an email'),
    /Unsupported file type\. Choose an \.html, \.htm, \.txt, or \.eml file\./,
  );
});
