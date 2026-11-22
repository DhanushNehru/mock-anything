'use strict';

// A busy port must produce an actionable message ("port N is already in use -
// pick another with --port") for record, serve and verify — not a raw
// EADDRINUSE stack. Other listen errors pass through unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startMockServer } = require('../src/server');
const { startRecorder } = require('../src/recorder');
const { friendlyListenError } = require('../src/errors');
const { saveCassette } = require('../src/cassettes');

const BIN = path.join(__dirname, '..', 'bin', 'mock-anything.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-port-'));
}

function seedDir() {
  const dir = tmpDir();
  saveCassette(dir, {
    request: { method: 'GET', path: '/a', headers: {}, body: '', bodyEncoding: 'utf8' },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}', bodyEncoding: 'utf8' },
    recordedAt: '2026-11-22T00:00:00.000Z',
  });
  return dir;
}

// Bind the port the same way the CLI does (wildcard), so the second bind
// deterministically gets EADDRINUSE.
function blockPort(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(port, () => resolve(srv));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('friendlyListenError rewrites only EADDRINUSE', () => {
  const busy = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  const friendly = friendlyListenError(busy, 8080);
  assert.match(friendly.message, /port 8080 is already in use/);
  assert.match(friendly.message, /--port/);
  assert.notEqual(friendly, busy);

  // every other error is returned untouched
  const other = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  assert.equal(friendlyListenError(other, 8080), other);
  const plain = new Error('plain');
  assert.equal(friendlyListenError(plain, 1), plain);
});

test('startMockServer rejects with the friendly message on a busy port', async () => {
  const port = await freePort();
  const blocker = await blockPort(port);
  try {
    await assert.rejects(startMockServer({ port, dir: seedDir() }), /port .* is already in use - pick another with --port/);
  } finally {
    blocker.close();
  }
});

test('startRecorder rejects with the friendly message on a busy port', async () => {
  const port = await freePort();
  const blocker = await blockPort(port);
  try {
    await assert.rejects(
      startRecorder({ target: 'http://127.0.0.1:1', port, dir: tmpDir() }),
      /port .* is already in use - pick another with --port/
    );
  } finally {
    blocker.close();
  }
});

test('CLI serve prints the friendly message and exits non-zero on a busy port', () => {
  return freePort().then(async (port) => {
    const blocker = await blockPort(port);
    try {
      const dir = seedDir();
      const res = spawnSync(process.execPath, [BIN, 'serve', '--port', String(port), '--dir', dir], { encoding: 'utf8' });
      assert.notEqual(res.status, 0, 'must exit non-zero');
      assert.match(res.stderr, /port .* is already in use - pick another with --port/);
      assert.doesNotMatch(res.stderr, /EADDRINUSE/);
    } finally {
      blocker.close();
    }
  });
});

test('CLI record prints the friendly message and exits non-zero on a busy port', async () => {
  const port = await freePort();
  const blocker = await blockPort(port);
  try {
    const res = spawnSync(
      process.execPath,
      [BIN, 'record', '--target', 'http://127.0.0.1:1', '--port', String(port), '--dir', tmpDir()],
      { encoding: 'utf8' }
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /already in use/);
    assert.match(res.stderr, /--port/);
  } finally {
    blocker.close();
  }
});

test('CLI verify prints the friendly message and exits non-zero on a busy port', async () => {
  const port = await freePort();
  const blocker = await blockPort(port);
  try {
    const res = spawnSync(
      process.execPath,
      [BIN, 'verify', '--port', String(port), '--dir', seedDir(), '--', process.execPath, '-e', 'process.exit(0)'],
      { encoding: 'utf8' }
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /already in use/);
  } finally {
    blocker.close();
  }
});

test('CLI still starts fine on a free port (no regression)', async () => {
  const port = await freePort();
  const dir = seedDir();
  const child = spawnSync(
    process.execPath,
    [BIN, 'serve', '--port', String(port), '--dir', dir],
    { encoding: 'utf8', timeout: 3000 }
  );
  // serve stays running until killed; spawnSync times out -> status null, but
  // stdout shows the startup line and stderr has no listen error.
  assert.match(child.stdout || '', /recorded interactions on http:\/\/localhost:/);
  assert.doesNotMatch(child.stderr || '', /already in use|EADDRINUSE/);
});
