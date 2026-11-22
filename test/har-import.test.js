'use strict';

// `mock-anything import capture.har` must turn a HAR 1.2 export into standard
// cassettes: decoded bodies, the same credential redaction as recording, and
// preserved order for repeated identical requests — so serve/verify/check
// work on the result unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { importHarFile, harEntryToCassette, parseHar, requestPath } = require('../src/har');
const { loadCassettes, decodeBody, matchKey } = require('../src/cassettes');
const { startMockServer } = require('../src/server');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.har');
const BIN = path.join(__dirname, '..', 'bin', 'mock-anything.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-har-'));
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    }).on('error', reject);
  });
}

test('fixture HAR parses to 5 entries', () => {
  const entries = parseHar(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(entries.length, 5);
});

test('import converts every entry to a cassette in capture order', () => {
  const dir = tmpDir();
  const written = importHarFile(FIXTURE, dir);
  assert.equal(written.length, 5);
  assert.deepEqual(
    written.map((w) => path.basename(w.file)),
    ['0001-get-posts-limit-1.json', '0002-post-posts.json', '0003-get-avatar-png.json', '0004-get-posts-limit-1.json', '0005-get-report.json']
  );

  const cassettes = loadCassettes(dir);
  assert.deepEqual(
    cassettes.map((c) => [c.request.method, c.request.path, c.response.status]),
    [
      ['GET', '/posts?_limit=1', 200],
      ['POST', '/posts', 201],
      ['GET', '/avatar.png', 200],
      ['GET', '/posts?_limit=1', 200],
      ['GET', '/report', 200],
    ]
  );
  assert.equal(cassettes[0].recordedAt, '2026-11-21T09:15:01.000Z');
});

test('import applies the same credential redaction as recording', () => {
  const dir = tmpDir();
  importHarFile(FIXTURE, dir);
  const [first, , , , ,] = loadCassettes(dir);
  assert.equal(first.request.headers.authorization, '<redacted>');
  assert.equal(first.request.headers['x-api-key'], '<redacted>');
  assert.equal(first.request.headers.accept, 'application/json');
  // set-cookie is redacted on responses too
  assert.equal(first.response.headers['set-cookie'], '<redacted>');
  assert.equal(first.response.headers['content-type'], 'application/json; charset=utf-8');
});

test('import decodes base64 response bodies and keeps binary as base64', () => {
  const dir = tmpDir();
  importHarFile(FIXTURE, dir);
  const cassettes = loadCassettes(dir);
  const png = cassettes[2];
  assert.equal(png.response.bodyEncoding, 'base64');
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]);
  assert.deepEqual(decodeBody(png.response), expected);
});

test('import decodes transfer encodings and strips the content-encoding header', () => {
  const dir = tmpDir();
  importHarFile(FIXTURE, dir);
  const cassettes = loadCassettes(dir);
  const report = cassettes[4];
  assert.equal(report.response.headers['content-encoding'], undefined);
  assert.equal(report.response.bodyEncoding, 'utf8');
  assert.equal(report.response.body, '{"ok":true,"n":42}');
  assert.deepEqual(JSON.parse(report.response.body), { ok: true, n: 42 });
});

test('request bodies import with the right encoding', () => {
  const dir = tmpDir();
  importHarFile(FIXTURE, dir);
  const cassettes = loadCassettes(dir);
  const post = cassettes[1];
  assert.equal(post.request.body, '{"title":"draft"}');
  assert.equal(post.request.bodyEncoding, 'utf8');
  assert.equal(post.request.headers['content-type'], 'application/json');
  assert.equal(post.request.headers.authorization, '<redacted>');
});

test('repeated identical requests keep their recorded order', () => {
  const dir = tmpDir();
  importHarFile(FIXTURE, dir);
  const cassettes = loadCassettes(dir);
  const dupA = cassettes[0];
  const dupB = cassettes[3];
  assert.equal(matchKey(dupA.request.method, dupA.request.path, dupA.request.body, dupA.request.headers['content-type']),
    matchKey(dupB.request.method, dupB.request.path, dupB.request.body, dupB.request.headers['content-type']));
  assert.ok(dupA.file < dupB.file, 'capture order must map to sequence order');
  assert.equal(dupA.response.body, '[{"id":1,"title":"first"}]');
  assert.equal(dupB.response.body, '[{"id":2,"title":"second"}]');
});

test('serve replays imported cassettes in order without any network', async () => {
  const dir = tmpDir();
  importHarFile(FIXTURE, dir);
  const mock = await startMockServer({ port: 0, dir });
  const port = mock.server.address().port;
  try {
    const first = await get(port, '/posts?_limit=1');
    assert.equal(first.status, 200);
    assert.equal(first.body.toString(), '[{"id":1,"title":"first"}]');
    // second identical request replays the next recorded response
    const second = await get(port, '/posts?_limit=1');
    assert.equal(second.body.toString(), '[{"id":2,"title":"second"}]');
    // binary response round-trips byte-for-byte
    const avatar = await get(port, '/avatar.png');
    assert.equal(avatar.status, 200);
    assert.deepEqual(avatar.body, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]));
    // gzipped HAR entry replays as decoded text
    const report = await get(port, '/report');
    assert.equal(report.body.toString(), '{"ok":true,"n":42}');
    assert.equal(report.headers['content-encoding'], undefined);
  } finally {
    mock.server.close();
  }
});

test('CLI: mock-anything import writes cassettes and list shows them', () => {
  const dir = tmpDir();
  const out = execFileSync(process.execPath, [BIN, 'import', FIXTURE, '--dir', dir], { encoding: 'utf8' });
  assert.match(out, /imported GET \/posts\?_limit=1 -> 200/);
  assert.match(out, /imported 5 entries/);

  const cassettes = loadCassettes(dir);
  assert.equal(cassettes.length, 5);
  const listOut = execFileSync(process.execPath, [BIN, 'list', '--dir', dir], { encoding: 'utf8' });
  assert.match(listOut, /5 recorded interactions/);
});

test('CLI: import without a file errors with usage', () => {
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'import'], { encoding: 'utf8', stdio: 'pipe' }),
    /import needs a HAR file/
  );
});

test('import rejects files that are not HAR 1.2', () => {
  const dir = tmpDir();
  const badJson = path.join(dir, 'bad.har');
  fs.writeFileSync(badJson, 'this is not json');
  assert.throws(() => importHarFile(badJson, dir), /not a valid JSON\/HAR file/);

  const notHar = path.join(dir, 'nothar.har');
  fs.writeFileSync(notHar, JSON.stringify({ hello: 'world' }));
  assert.throws(() => importHarFile(notHar, dir), /missing log\.entries/);
});

test('requestPath strips the origin and keeps the query', () => {
  assert.equal(requestPath('https://api.example.com/posts?_limit=1'), '/posts?_limit=1');
  assert.equal(requestPath('http://localhost:8080/'), '/');
  assert.equal(requestPath('/already/a/path?x=1'), '/already/a/path?x=1');
});

test('harEntryToCassette tolerates missing postData and content', () => {
  const cassette = harEntryToCassette({
    startedDateTime: '2026-01-01T00:00:00.000Z',
    request: { method: 'get', url: 'https://x.test/p' },
    response: { status: 204 },
  });
  assert.equal(cassette.request.method, 'GET');
  assert.equal(cassette.request.path, '/p');
  assert.equal(cassette.request.body, '');
  assert.equal(cassette.response.status, 204);
  assert.equal(cassette.response.body, '');
  assert.equal(cassette.recordedAt, '2026-01-01T00:00:00.000Z');
});

test('gzip fixture content really is gzip of the JSON', () => {
  // guards the fixture itself: entry 5 must be a valid gzip payload
  const har = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const raw = Buffer.from(har.log.entries[4].response.content.text, 'base64');
  assert.equal(zlib.gunzipSync(raw).toString(), '{"ok":true,"n":42}');
});
