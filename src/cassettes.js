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

// --- HAR 1.2 export ---------------------------------------------------------

function headersToHarArray(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
}

// One cassette -> one HAR entry. Cassette request paths are origin-less, so
// the recorded host header (kept by the recorder) supplies the origin; without
// one we fall back to localhost. Bodies stored base64 keep their base64 text
// and gain "encoding": "base64" per HAR 1.2, so devtools decodes them; textual
// bodies export as plain text.
function cassetteToHarEntry(cassette) {
  const host = (cassette.request.headers && cassette.request.headers.host) || 'localhost';
  const url = new URL(cassette.request.path, `http://${host}`);
  const reqBody = cassette.request.body || '';
  const resBody = cassette.response.body || '';
  const reqType = (cassette.request.headers && cassette.request.headers['content-type']) || '';
  const resType = (cassette.response.headers && cassette.response.headers['content-type']) || '';
  const reqBytes = decodeBody(cassette.request);
  const resBytes = decodeBody(cassette.response);
  const reqBase64 = cassette.request.bodyEncoding === 'base64';
  const resBase64 = cassette.response.bodyEncoding === 'base64';
  return {
    startedDateTime: cassette.recordedAt || new Date().toISOString(),
    time: 0,
    request: {
      method: cassette.request.method,
      url: url.toString(),
      httpVersion: 'HTTP/1.1',
      headers: headersToHarArray(cassette.request.headers),
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
      cookies: [],
      headersSize: -1,
      bodySize: reqBytes.length,
      ...(reqBody
        ? {
            postData: {
              mimeType: reqType || 'application/octet-stream',
              ...(reqBase64 ? { encoding: 'base64' } : {}),
              text: reqBody,
            },
          }
        : {}),
    },
    response: {
      status: cassette.response.status,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: headersToHarArray(cassette.response.headers),
      content: {
        size: resBytes.length,
        mimeType: resType || 'application/octet-stream',
        ...(resBase64 ? { encoding: 'base64' } : {}),
        text: resBody,
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: resBytes.length,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
}

// The whole cassette directory as one HAR 1.2 document, in recorded order.
function cassettesToHar(cassettes) {
  const first = (cassettes[0] && cassettes[0].recordedAt) || new Date().toISOString();
  return {
    log: {
      version: '1.2',
      creator: { name: 'mock-anything', version: require('../package.json').version },
      pages: [{ startedDateTime: first, id: 'page_1', title: 'mock-anything recording' }],
      entries: cassettes.map(cassetteToHarEntry),
    },
  };
}

module.exports = {
  saveCassette,
  loadCassettes,
  matchKey,
  canonicalBody,
  decodeBody,
  cassetteDir,
  cassettesToHar,
  cassetteToHarEntry,
};
