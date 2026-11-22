'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchKey, canonicalBody } = require('../src/cassettes');
const { diffJson } = require('../src/check');
const { redactHeaders } = require('../src/redact');

test('JSON bodies match regardless of key order', () => {
  const a = matchKey('POST', '/x', '{"a":1,"b":[2,3]}', 'application/json');
  const b = matchKey('POST', '/x', '{"b":[2,3],"a":1}', 'application/json');
  assert.equal(a, b);
});

test('different bodies produce different keys', () => {
  const a = matchKey('POST', '/x', '{"a":1}', 'application/json');
  const b = matchKey('POST', '/x', '{"a":2}', 'application/json');
  assert.notEqual(a, b);
});

test('non-JSON bodies compare literally', () => {
  assert.equal(canonicalBody('a=1&b=2', 'application/x-www-form-urlencoded'), 'a=1&b=2');
});

test('diffJson reports value, structural and array changes', () => {
  assert.deepEqual(diffJson({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffJson({ a: 1 }, { a: 2 }), ['$.a: 1 -> 2']);
  assert.deepEqual(diffJson({ a: { b: 1 } }, { a: {} }), ['$.a.b: missing from live response']);
  assert.deepEqual(diffJson([1, 2], [1]), ['$: array length 2 -> 1']);
});

test('redactHeaders strips credentials case-insensitively', () => {
  const out = redactHeaders({ Authorization: 'Bearer x', 'X-API-Key': 'k', Accept: 'application/json' });
  assert.equal(out.authorization, '<redacted>');
  assert.equal(out['x-api-key'], '<redacted>');
  assert.equal(out.accept, 'application/json');
});
