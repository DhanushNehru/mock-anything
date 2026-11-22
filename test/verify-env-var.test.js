'use strict';

// verify --env-var NAME (repeatable) must set NAME to the mock URL for the
// child process, alongside the existing MOCK_ANYTHING_URL/API_BASE_URL/
// BASE_URL defaults. Invalid names are rejected.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-envvar-'));
}

function seedDir() {
  const dir = tmpDir();
  saveCassette(dir, {
    request: { method: 'GET', path: '/a', headers: {}, body: '', bodyEncoding: 'utf8' },
    response: { status: 200, headers: {}, body: '{}', bodyEncoding: 'utf8' },
    recordedAt: '2026-11-22T00:00:00.000Z',
  });
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

// Child prints the variables we care about as KEY=VALUE lines.
const PRINT_SCRIPT = [
  'for (const k of ["MOCK_ANYTHING_URL","API_BASE_URL","BASE_URL","VITE_API_URL","NEXT_PUBLIC_API_URL","SERVICE_URL"])',
  '  console.log(k + "=" + (process.env[k] ?? "<unset>"));',
].join(' ');

async function runVerify(extraArgs, childScript = PRINT_SCRIPT) {
  const port = await freePort();
  const dir = seedDir();
  return spawnSync(
    process.execPath,
    [BIN, 'verify', '--port', String(port), '--dir', dir, ...extraArgs, '--', process.execPath, '-e', childScript],
    { encoding: 'utf8' }
  );
}

function envMap(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

test('named --env-var variables receive the mock URL alongside the defaults', async () => {
  const res = await runVerify(['--env-var', 'VITE_API_URL', '--env-var', 'NEXT_PUBLIC_API_URL']);
  assert.equal(res.status, 0, res.stderr);
  const env = envMap(res.stdout);
  const url = env.MOCK_ANYTHING_URL;
  assert.match(url, /^http:\/\/localhost:\d+$/);
  assert.equal(env.API_BASE_URL, url);
  assert.equal(env.BASE_URL, url);
  assert.equal(env.VITE_API_URL, url);
  assert.equal(env.NEXT_PUBLIC_API_URL, url);
  assert.equal(env.SERVICE_URL, '<unset>', 'unnamed variables stay unset');
});

test('without --env-var the defaults are unchanged', async () => {
  const res = await runVerify([]);
  assert.equal(res.status, 0, res.stderr);
  const env = envMap(res.stdout);
  assert.match(env.MOCK_ANYTHING_URL, /^http:\/\/localhost:\d+$/);
  assert.equal(env.VITE_API_URL, '<unset>');
});

test('the named variable actually reaches a child that fetches through it', async () => {
  const script = 'fetch(process.env.SERVICE_URL + "/a").then(r => process.exit(r.status === 200 ? 0 : 3), () => process.exit(2))';
  const res = await runVerify(['--env-var', 'SERVICE_URL'], script);
  assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /cassettes used: 1\/1/);
});

test('an invalid --env-var name is rejected', async () => {
  const res = await runVerify(['--env-var', '1BAD-NAME']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /invalid --env-var name/);
});

test('--env-var without a value is rejected (missing argument)', async () => {
  const res = await runVerify(['--env-var']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--env-var needs a variable name/);
});
