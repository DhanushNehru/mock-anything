'use strict';

// `list --json` must print a valid JSON array and nothing else on stdout,
// while the human table stays the default.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveCassette } = require('../src/cassettes');

const BIN = path.join(__dirname, '..', 'bin', 'mock-anything.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-list-'));
}

function runList(args) {
  return execFileSync(process.execPath, [BIN, 'list', ...args], { encoding: 'utf8' });
}

function seedCassettes(dir) {
  saveCassette(dir, {
    request: {
      method: 'GET',
      path: '/posts?_limit=1',
      headers: { 'content-type': 'application/json' },
      body: '',
      bodyEncoding: 'utf8',
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '[{"id":1,"title":"a"}]',
      bodyEncoding: 'utf8',
    },
    recordedAt: '2026-11-20T10:00:00.000Z',
  });
  saveCassette(dir, {
    request: {
      method: 'POST',
      path: '/posts',
      headers: { 'content-type': 'application/json' },
      body: '{"title":"draft"}',
      bodyEncoding: 'utf8',
    },
    response: {
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"id":101,"title":"draft"}',
      bodyEncoding: 'utf8',
    },
    recordedAt: '2026-11-20T10:00:01.500Z',
  });
}

test('list --json prints a parseable JSON array with method, path, status, file, recordedAt', () => {
  const dir = tmpDir();
  seedCassettes(dir);

  const stdout = runList(['--dir', dir, '--json']);
  // JSON.parse over the whole stdout proves nothing else is printed.
  const rows = JSON.parse(stdout);

  assert.ok(Array.isArray(rows), 'output must be a JSON array');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    method: 'GET',
    path: '/posts?_limit=1',
    status: 200,
    file: '0001-get-posts-limit-1.json',
    recordedAt: '2026-11-20T10:00:00.000Z',
  });
  assert.deepEqual(rows[1], {
    method: 'POST',
    path: '/posts',
    status: 201,
    file: '0002-post-posts.json',
    recordedAt: '2026-11-20T10:00:01.500Z',
  });
});

test('list --json keeps cassette order so scripts see the recording sequence', () => {
  const dir = tmpDir();
  seedCassettes(dir);

  const rows = JSON.parse(runList(['--dir', dir, '--json']));
  assert.deepEqual(rows.map((r) => r.file), ['0001-get-posts-limit-1.json', '0002-post-posts.json']);
  assert.deepEqual(rows.map((r) => r.method), ['GET', 'POST']);
});

test('list --json on an empty dir prints an empty JSON array', () => {
  const dir = tmpDir();
  const stdout = runList(['--dir', dir, '--json']);
  assert.deepEqual(JSON.parse(stdout), []);
});

test('list without --json keeps the human table as default', () => {
  const dir = tmpDir();
  seedCassettes(dir);

  const stdout = runList(['--dir', dir]);
  assert.match(stdout, /GET\s+\/posts\?_limit=1\s+-> 200/);
  assert.match(stdout, /POST\s+\/posts\s+-> 201/);
  assert.match(stdout, /2 recorded interactions/);
  assert.throws(() => JSON.parse(stdout), 'human output must not be JSON');
});

test('list without --json on an empty dir keeps the friendly message', () => {
  const dir = tmpDir();
  const stdout = runList(['--dir', dir]);
  assert.match(stdout, /no cassettes found/);
});
