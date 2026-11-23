'use strict';

// The docs must stay true: the README links both docs pages, the cassette
// format reference documents every field a real cassette contains, and the
// quickstart only shows commands the CLI actually has.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveCassette } = require('../src/cassettes');

// The commands main() dispatches on (src/cli.js); kept literal here so this
// docs PR stays independent of other in-flight CLI changes.
const CLI_COMMANDS = ['record', 'serve', 'verify', 'check', 'list', 'import'];

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const QUICKSTARTS = path.join(ROOT, 'docs', 'quickstarts.md');
const FORMAT = path.join(ROOT, 'docs', 'cassette-format.md');
const formatDoc = fs.readFileSync(FORMAT, 'utf8');
const quickDoc = fs.readFileSync(QUICKSTARTS, 'utf8');

test('README links the quickstarts and the cassette format reference', () => {
  assert.match(README, /docs\/quickstarts\.md/);
  assert.match(README, /docs\/cassette-format\.md/);
  assert.ok(fs.existsSync(QUICKSTARTS), 'docs/quickstarts.md exists');
  assert.ok(fs.existsSync(FORMAT), 'docs/cassette-format.md exists');
});

test('cassette format reference documents every field a saved cassette has', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-docs-'));
  const file = saveCassette(dir, {
    request: {
      method: 'POST',
      path: '/posts?x=1',
      headers: { authorization: '<redacted>', 'content-type': 'application/json' },
      body: '{"b":2,"a":1}',
      bodyEncoding: 'utf8',
    },
    response: {
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"id":3}',
      bodyEncoding: 'utf8',
      stream: true,
      chunks: [{ data: 'data: hi\n\n', encoding: 'utf8', delayMs: 0 }],
      truncated: true,
    },
    recordedAt: '2026-11-22T00:00:00.000Z',
    upstream: { name: 'api', target: 'https://api.example.com', prefix: '/api', path: '/posts' },
  });
  const cassette = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Walk every key of the real file and require the leaf field name in the
  // doc (the doc uses one table per object under `## request` / `## response`).
  // `headers` maps are data, not schema, so header names themselves are exempt.
  const leaves = [];
  (function walk(value, prefix) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (prefix.endsWith('headers')) return; // documented as a whole
      for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
    } else {
      leaves.push(prefix.split('.').pop());
    }
  })(cassette, '');
  for (const leaf of leaves) {
    assert.ok(formatDoc.includes(leaf), `cassette-format.md does not document field "${leaf}"`);
  }
  for (const section of ['`request`', '`response`', '`upstream`', 'recordedAt']) {
    assert.ok(formatDoc.includes(section), `cassette-format.md missing section ${section}`);
  }
  // The schema-level tokens the reference must explain.
  for (const token of ['<redacted>', '"utf8"', '"base64"', 'MOCK_ANYTHING_REDACT', 'recordedAt', 'match key', 'sha256']) {
    assert.ok(formatDoc.includes(token), `cassette-format.md missing "${token}"`);
  }
});

test('quickstarts only shows real CLI commands and the env swap', () => {
  assert.match(quickDoc, /MOCK_ANYTHING_URL/);
  const shown = [...quickDoc.matchAll(/mock-anything (record|serve|verify|check|list|import)\b/g)].map((m) => m[1]);
  assert.ok(shown.includes('record') && shown.includes('verify'), 'quickstarts show record and verify');
  // Every `mock-anything <word>` invocation in the doc names a real command.
  for (const m of quickDoc.matchAll(/mock-anything ([a-z-]+)/g)) {
    assert.ok(CLI_COMMANDS.includes(m[1]), `quickstart shows unknown command "${m[1]}"`);
  }
  // The three requested frameworks are covered.
  assert.match(quickDoc, /Express/);
  assert.match(quickDoc, /Next\.js/);
  assert.match(quickDoc, /[Pp]ython/);
});
