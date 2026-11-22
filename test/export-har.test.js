'use strict';

// mock-anything export --har out.har writes the cassette directory as a
// HAR 1.2 document: valid structure, base64 bodies keep "encoding": "base64",
// bodies round-trip byte-for-byte, and the CLI errors are friendly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveCassette, loadCassettes, decodeBody, cassettesToHar } = require('../src/cassettes');

const BIN = path.join(__dirname, '..', 'bin', 'mock-anything.js');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-export-'));
}

function seedDir() {
  const dir = tmpDir();
  saveCassette(dir, {
    request: {
      method: 'GET',
      path: '/posts?_limit=1',
      headers: { host: 'api.example.com', accept: 'application/json' },
      body: '',
      bodyEncoding: 'utf8',
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
      body: '[{"id":1,"title":"a"}]',
      bodyEncoding: 'utf8',
    },
    recordedAt: '2026-11-21T09:15:01.000Z',
  });
  saveCassette(dir, {
    request: {
      method: 'POST',
      path: '/posts',
      headers: { host: 'api.example.com', 'content-type': 'application/json' },
      body: '{"title":"draft"}',
      bodyEncoding: 'utf8',
    },
    response: {
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"id":101,"title":"draft"}',
      bodyEncoding: 'utf8',
    },
    recordedAt: '2026-11-21T09:15:02.000Z',
  });
  saveCassette(dir, {
    request: {
      method: 'GET',
      path: '/avatar.png',
      headers: { host: 'api.example.com', accept: 'image/png' },
      body: '',
      bodyEncoding: 'utf8',
    },
    response: {
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: PNG_BYTES.toString('base64'),
      bodyEncoding: 'base64',
    },
    recordedAt: '2026-11-21T09:15:03.000Z',
  });
  return dir;
}

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function exportViaCli(dir) {
  const out = path.join(tmpDir(), 'out.har');
  const res = run(['export', '--har', out, '--dir', dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /exported 3 interactions/);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

// Structural validation approximating what a HAR consumer (browser devtools)
// requires.
function assertValidHar(har) {
  assert.equal(har.log.version, '1.2');
  assert.ok(har.log.creator && har.log.creator.name);
  assert.ok(Array.isArray(har.log.entries));
  for (const e of har.log.entries) {
    assert.ok(e.startedDateTime && !Number.isNaN(Date.parse(e.startedDateTime)));
    assert.ok(e.request && typeof e.request.method === 'string');
    assert.doesNotThrow(() => new URL(e.request.url));
    assert.ok(Array.isArray(e.request.headers));
    assert.ok(e.response && Number.isInteger(e.response.status));
    assert.ok(e.response.content && typeof e.response.content.text === 'string');
    assert.ok(e.timings && typeof e.timings.wait === 'number');
  }
}

test('exported HAR is structurally valid HAR 1.2', () => {
  assertValidHar(exportViaCli(seedDir()));
});

test('export preserves method, url with query, headers, status and recordedAt in order', () => {
  const har = exportViaCli(seedDir());
  assert.equal(har.log.entries.length, 3);
  const [get, post, png] = har.log.entries;

  assert.equal(get.request.method, 'GET');
  assert.equal(get.request.url, 'http://api.example.com/posts?_limit=1');
  assert.deepEqual(get.request.queryString, [{ name: '_limit', value: '1' }]);
  assert.ok(get.request.headers.some((h) => h.name === 'host' && h.value === 'api.example.com'));
  assert.equal(get.response.status, 200);
  assert.equal(get.response.content.mimeType, 'application/json');
  assert.equal(get.response.content.text, '[{"id":1,"title":"a"}]');
  assert.equal(get.response.content.encoding, undefined, 'textual bodies have no encoding field');
  assert.equal(get.startedDateTime, '2026-11-21T09:15:01.000Z');

  assert.equal(post.request.method, 'POST');
  assert.equal(post.request.postData.mimeType, 'application/json');
  assert.equal(post.request.postData.text, '{"title":"draft"}');
  assert.equal(post.response.status, 201);

  assert.equal(png.request.url, 'http://api.example.com/avatar.png');
});

test('base64 bodies export with the encoding field and round-trip byte-for-byte', () => {
  const har = exportViaCli(seedDir());
  const png = har.log.entries[2];
  assert.equal(png.response.content.encoding, 'base64');
  assert.equal(png.response.content.mimeType, 'image/png');
  assert.equal(png.response.content.size, PNG_BYTES.length);
  assert.deepEqual(Buffer.from(png.response.content.text, 'base64'), PNG_BYTES);
});

test('every exported body decodes back to the cassette bytes', () => {
  const dir = seedDir();
  const har = exportViaCli(dir);
  const cassettes = loadCassettes(dir);
  assert.equal(har.log.entries.length, cassettes.length);
  har.log.entries.forEach((entry, i) => {
    const c = cassettes[i];
    const enc = entry.response.content.encoding === 'base64' ? 'base64' : 'utf8';
    assert.deepEqual(Buffer.from(entry.response.content.text, enc), decodeBody(c.response));
    assert.equal(entry.response.status, c.response.status);
    assert.equal(entry.request.method, c.request.method);
    assert.ok(entry.request.url.endsWith(c.request.path));
  });
});

test('cassettesToHar falls back to localhost when no host header was recorded', () => {
  const dir = tmpDir();
  saveCassette(dir, {
    request: { method: 'GET', path: '/x', headers: {}, body: '', bodyEncoding: 'utf8' },
    response: { status: 200, headers: {}, body: 'ok', bodyEncoding: 'utf8' },
    recordedAt: '2026-11-22T00:00:00.000Z',
  });
  const har = cassettesToHar(loadCassettes(dir));
  assert.equal(har.log.entries[0].request.url, 'http://localhost/x');
});

test('export without --har fails with a clear message', () => {
  const res = run(['export', '--dir', seedDir()]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /export needs --har <file>/);
});

test('export --har without a value fails with a clear message', () => {
  const res = run(['export', '--har']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--har needs a file path/);
});

test('export on an empty cassette dir fails with a clear message', () => {
  const res = run(['export', '--har', path.join(tmpDir(), 'out.har'), '--dir', tmpDir()]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no cassettes found/);
});
