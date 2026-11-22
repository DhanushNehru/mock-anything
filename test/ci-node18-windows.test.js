'use strict';

// CI must cover Node 18 (the engines floor) and Windows, and `verify` must be
// able to spawn its test command there: on Windows the npm bin is a .cmd shim
// that only the platform shell can launch, so spawn must go through the shell
// on win32. The test script must not rely on shell glob expansion either
// (cmd.exe does not expand globs and Node 18's --test has no glob support).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnShellFor, quoteWinArg } = require('../src/verify');
const { saveCassette } = require('../src/cassettes');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'mock-anything.js');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function seededDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-ci-'));
  saveCassette(dir, {
    request: { method: 'GET', path: '/ping', headers: {}, body: '', bodyEncoding: 'utf8' },
    response: { status: 200, headers: {}, body: 'pong', bodyEncoding: 'utf8' },
    recordedAt: '2026-11-22T00:00:00.000Z',
  });
  return dir;
}

test('spawn uses the platform shell on Windows only', () => {
  assert.equal(spawnShellFor('win32'), true);
  assert.equal(spawnShellFor('linux'), false);
  assert.equal(spawnShellFor('darwin'), false);
});

test('CI matrix runs Node 18, 20, 22 on ubuntu and windows', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /node-version:\s*\[[^\]]*\b18\b[^\]]*\b20\b[^\]]*\b22\b[^\]]*\]/, 'node matrix must be [18, 20, 22]');
  assert.match(ci, /windows-latest/, 'a Windows runner is required');
  assert.match(ci, /ubuntu-latest/, 'ubuntu runner stays');
});

test('test script uses the runner built-in discovery, not a path or glob', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=18');
  // `node --test` with no path makes the runner discover test files itself:
  // identical on Node 18/20/22 and on Windows (no shell glob, and Node 22
  // would treat a bare `test/` directory argument as a module).
  assert.equal(pkg.scripts.test, 'node --test');
  assert.doesNotMatch(pkg.scripts.test, /\*/, 'no glob in the test script');
});

test('windows shell command line keeps argument boundaries and spaces', () => {
  assert.equal(quoteWinArg('npm'), 'npm');
  assert.equal(quoteWinArg('--version'), '--version');
  assert.equal(quoteWinArg('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  const BS = String.fromCharCode(92); // backslash
  assert.equal(quoteWinArg('say "hi"'), '"say ' + BS + '"hi' + BS + '""');
  assert.equal(quoteWinArg('C:\\my dir\\tool.cmd'), '"C:\\my dir\\tool.cmd"');
});

test('sources avoid APIs newer than Node 18', () => {
  const tooNew = [/Object\.hasOwn\(/, /structuredClone\(/, /Array\.fromAsync\(/, /\.at\(-?\d/];
  for (const dir of ['src', 'bin']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir))) {
      if (!file.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
      for (const re of tooNew) {
        assert.doesNotMatch(text, re, `${dir}/${file} uses ${re} which needs Node > 18`);
      }
    }
  }
});

test('verify runs a test command through the spawned mock server', async () => {
  const port = await freePort();
  const dir = seededDir();
  const res = run([
    'verify', '--port', String(port), '--dir', dir, '--',
    process.execPath, '-e', 'console.log("got " + process.env.MOCK_ANYTHING_URL)',
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /PASS: the suite ran entirely against recorded responses/);
  assert.match(res.stdout, /got http:\/\/localhost:/); // MOCK_ANYTHING_URL injected
});

test('verify can spawn npm itself (the Windows .cmd case)', async () => {
  const port = await freePort();
  const dir = seededDir();
  const res = run(['verify', '--port', String(port), '--dir', dir, '--', 'npm', '--version']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /PASS:/);
});
