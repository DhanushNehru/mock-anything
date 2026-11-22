'use strict';

// verify --strict must exit 1 when any cassette goes unused, while the
// default mode only warns (and still exits with the suite's code).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { saveCassette } = require('../src/cassettes');

const BIN = path.join(__dirname, '..', 'bin', 'mock-anything.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-strict-'));
}

function seedDir() {
  const dir = tmpDir();
  for (const p of ['/a', '/b']) {
    saveCassette(dir, {
      request: { method: 'GET', path: p, headers: {}, body: '', bodyEncoding: 'utf8' },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: `{"path":"${p}"}`, bodyEncoding: 'utf8' },
      recordedAt: '2026-11-22T00:00:00.000Z',
    });
  }
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A child "suite" that fetches the given paths through MOCK_ANYTHING_URL and
// exits 0 when all answer 200.
function suiteScript(paths) {
  const fetches = paths.map((p) => `fetch(process.env.MOCK_ANYTHING_URL + ${JSON.stringify(p)}).then(r => { if (r.status !== 200) process.exit(3); })`).join(',');
  return `Promise.all([${fetches}]).then(() => process.exit(0), () => process.exit(2))`;
}

async function runVerify(args, childScript) {
  const port = await freePort();
  const dir = seedDir();
  return spawnSync(
    process.execPath,
    [BIN, 'verify', '--port', String(port), '--dir', dir, ...args, '--', process.execPath, '-e', childScript],
    { encoding: 'utf8' }
  );
}

test('default mode warns about unused cassettes but still passes', async () => {
  const res = await runVerify([], suiteScript(['/a']));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /cassettes used: 1\/2/);
  assert.match(res.stdout, /never requested: 0002/);
  assert.match(res.stdout, /PASS/);
});

test('--strict exits 1 when a cassette goes unused', async () => {
  const res = await runVerify(['--strict'], suiteScript(['/a']));
  assert.equal(res.status, 1, `expected exit 1; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /never requested: 0002/);
  assert.match(res.stdout, /--strict: 1 of 2 cassette\(s\) were never requested/);
});

test('--strict passes when every cassette is used', async () => {
  const res = await runVerify(['--strict'], suiteScript(['/a', '/b']));
  assert.equal(res.status, 0, `expected exit 0; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /cassettes used: 2\/2/);
  assert.match(res.stdout, /PASS/);
  assert.doesNotMatch(res.stdout, /never requested/);
});

test('--strict keeps the suite failure code when the suite fails', async () => {
  const res = await runVerify(['--strict'], 'process.exit(7)');
  assert.equal(res.status, 7);
  assert.match(res.stdout, /FAIL: the command exited with code 7/);
});
