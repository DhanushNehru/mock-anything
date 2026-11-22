'use strict';

// Unknown --flags must fail fast, naming the flag(s), instead of being
// silently dropped (a typo like --targt used to cause a confusing
// "record needs --target" later). Positionals and the verify "--" separator
// keep working.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFlags } = require('../src/cli');
const { saveCassette } = require('../src/cassettes');

const BIN = path.join(__dirname, '..', 'bin', 'mock-anything.js');

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function seededDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-flags-'));
  saveCassette(dir, {
    request: { method: 'GET', path: '/a', headers: {}, body: '', bodyEncoding: 'utf8' },
    response: { status: 200, headers: {}, body: '{}', bodyEncoding: 'utf8' },
    recordedAt: '2026-11-22T00:00:00.000Z',
  });
  return dir;
}

test('parseFlags collects unknown --flags separately from positionals', () => {
  const { flags, rest, unknown } = parseFlags(['--dir', 'mocks', '--targt', 'x', 'positional', '--']);
  assert.equal(flags.dir, 'mocks');
  assert.deepEqual(unknown, ['--targt']);
  assert.deepEqual(rest, ['x', 'positional', '--']);
});

test('parseFlags keeps known flags out of unknown', () => {
  const { unknown } = parseFlags(['--target', 'http://x', '--port', '9000', '--dir', 'd']);
  assert.deepEqual(unknown, []);
});

test('a typoed flag exits non-zero and names the flag', () => {
  const res = run(['list', '--targt', 'x']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown flag: --targt/);
  assert.match(res.stderr, /Usage:/); // the relevant usage is included
});

test('record --targt fails fast naming the typo instead of "needs --target"', () => {
  const res = run(['record', '--targt', 'http://example.com']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown flag: --targt/);
  assert.doesNotMatch(res.stderr, /record needs --target/);
});

test('multiple unknown flags are all named', () => {
  const res = run(['serve', '--foo', '--bar']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown flags: --foo, --bar/);
});

test('known flags and positional args still work', () => {
  const dir = seededDir();
  const res = run(['list', '--dir', dir, 'extra-positional']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /1 recorded interactions/);
});

test('verify still works across the -- separator', () => {
  const dir = seededDir();
  const res = run(['verify', '--dir', dir, '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /PASS/);
});

test('verify rejects an unknown flag before the -- separator', () => {
  const res = run(['verify', '--bogus', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown flag: --bogus/);
});
