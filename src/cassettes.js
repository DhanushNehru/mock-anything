'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// One cassette is one recorded HTTP exchange:
// { request: {method, path, headers, body, bodyEncoding},
//   response: {status, headers, body, bodyEncoding}, recordedAt }
// Bodies are UTF-8 text, or base64 when bodyEncoding is "base64".

function cassetteDir(dir) {
  return path.join(dir, 'cassettes');
}

function slugify(method, reqPath) {
  const slug = reqPath
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'root';
  return `${method.toLowerCase()}-${slug}`;
}

function canonicalBody(body, contentType) {
  if (body == null || body === '') return '';
  if (contentType && contentType.includes('application/json')) {
    try {
      return JSON.stringify(sortJson(JSON.parse(body)));
    } catch {
      return body;
    }
  }
  return body;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortJson(value[k])])
    );
  }
  return value;
}

// The identity of a request: method + full path (with query) + canonical body.
function matchKey(method, reqPath, body, contentType) {
  const canonical = canonicalBody(body, contentType);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${method.toUpperCase()} ${reqPath} :: ${hash}`;
}

function saveCassette(dir, cassette) {
  const cdir = cassetteDir(dir);
  fs.mkdirSync(cdir, { recursive: true });
  const seq = String(nextSequence(cdir)).padStart(4, '0');
  const file = path.join(cdir, `${seq}-${slugify(cassette.request.method, cassette.request.path)}.json`);
  fs.writeFileSync(file, JSON.stringify(cassette, null, 2) + '\n');
  return file;
}

function nextSequence(cdir) {
  let max = 0;
  for (const f of safeList(cdir)) {
    const m = /^(\d+)-/.exec(f);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function safeList(cdir) {
  try {
    return fs.readdirSync(cdir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function loadCassettes(dir) {
  const cdir = cassetteDir(dir);
  return safeList(cdir).map((f) => {
    const cassette = JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8'));
    cassette.file = f;
    cassette.key = matchKey(
      cassette.request.method,
      cassette.request.path,
      cassette.request.body,
      cassette.request.headers && cassette.request.headers['content-type']
    );
    return cassette;
  });
}

function decodeBody(entry) {
  if (entry.bodyEncoding === 'base64') return Buffer.from(entry.body || '', 'base64');
  return Buffer.from(entry.body || '', 'utf8');
}

module.exports = { saveCassette, loadCassettes, matchKey, canonicalBody, decodeBody, cassetteDir };
