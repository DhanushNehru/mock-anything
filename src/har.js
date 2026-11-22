'use strict';

// HAR 1.2 import: browsers, Proxyman, Charles and mitmproxy all export HAR.
// Importing one turns an existing capture into standard cassettes that
// serve / verify / check consume unchanged.

const fs = require('fs');
const zlib = require('zlib');
const { saveCassette } = require('./cassettes');
const { redactHeaders } = require('./redact');
const { HOP_BY_HOP, isTextual } = require('./recorder');

// HAR headers are [{name, value}] pairs; cassettes store a lowercase object.
function headersArrayToObject(headers) {
  const out = {};
  for (const h of headers || []) {
    if (!h || typeof h.name !== 'string' || h.name === '') continue;
    out[h.name.toLowerCase()] = h.value == null ? '' : String(h.value);
  }
  return out;
}

// HAR bodies carry an optional "encoding": "base64" field. Decode to bytes
// first, then store exactly like the recorder: textual bodies as UTF-8,
// binary bodies as base64.
function bodyField(text, encoding, mimeType) {
  const buf = encoding === 'base64'
    ? Buffer.from(text || '', 'base64')
    : Buffer.from(text || '', 'utf8');
  if (isTextual(mimeType)) {
    return { body: buf.toString('utf8'), bodyEncoding: 'utf8' };
  }
  return { body: buf.toString('base64'), bodyEncoding: 'base64' };
}

// Mirror the recorder: transfer encodings are decoded before storage.
function decodeContentEncoding(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch {
    // keep the raw bytes if decoding fails, like the recorder does
  }
  return buf;
}

// Cassettes key requests on path + query, not the absolute URL.
function requestPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url || '/';
  }
}

function harEntryToCassette(entry) {
  const req = entry.request || {};
  const res = entry.response || {};
  const reqHeaders = headersArrayToObject(req.headers);
  const postData = req.postData || null;
  const reqMime = (postData && postData.mimeType) || reqHeaders['content-type'] || '';
  const reqBody = postData && postData.text != null
    ? bodyField(postData.text, postData.encoding, reqMime)
    : { body: '', bodyEncoding: 'utf8' };

  // Response headers: hop-by-hop and content-encoding are dropped, like the
  // recorder, after the body is decoded.
  const resHeadersRaw = headersArrayToObject(res.headers);
  const content = res.content || {};
  let resBuf = content.encoding === 'base64'
    ? Buffer.from(content.text || '', 'base64')
    : Buffer.from(content.text || '', 'utf8');
  const contentEncoding = resHeadersRaw['content-encoding'];
  if (contentEncoding) resBuf = decodeContentEncoding(resBuf, contentEncoding);
  const resHeaders = {};
  for (const [name, value] of Object.entries(resHeadersRaw)) {
    if (!HOP_BY_HOP.has(name) && name !== 'content-encoding') resHeaders[name] = value;
  }
  const resMime = content.mimeType || resHeaders['content-type'] || '';
  const resBody = isTextual(resMime)
    ? { body: resBuf.toString('utf8'), bodyEncoding: 'utf8' }
    : { body: resBuf.toString('base64'), bodyEncoding: 'base64' };

  return {
    request: {
      method: (req.method || 'GET').toUpperCase(),
      path: requestPath(req.url),
      headers: redactHeaders(reqHeaders),
      body: reqBody.body,
      bodyEncoding: reqBody.bodyEncoding,
    },
    response: {
      status: res.status || 0,
      headers: redactHeaders(resHeaders),
      body: resBody.body,
      bodyEncoding: resBody.bodyEncoding,
    },
    recordedAt: entry.startedDateTime || new Date().toISOString(),
  };
}

function parseHar(text) {
  let har;
  try {
    har = JSON.parse(text);
  } catch (err) {
    throw new Error(`not a valid JSON/HAR file: ${err.message}`);
  }
  const entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : null;
  if (!entries) throw new Error('not a HAR 1.2 file: missing log.entries');
  return entries;
}

// Convert every entry, in capture order, to one cassette. saveCassette
// numbers files in call order, so repeated identical requests keep their
// recorded order — the same queue behavior the recorder produces.
function importHarFile(harPath, dir) {
  const entries = parseHar(fs.readFileSync(harPath, 'utf8'));
  const written = [];
  for (const entry of entries) {
    const cassette = harEntryToCassette(entry);
    const file = saveCassette(dir, cassette);
    written.push({ file, cassette });
  }
  return written;
}

module.exports = { importHarFile, harEntryToCassette, parseHar, requestPath, headersArrayToObject, bodyField };
