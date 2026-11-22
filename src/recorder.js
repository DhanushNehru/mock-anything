'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { saveCassette } = require('./cassettes');
const { friendlyListenError } = require('./errors');
const { redactHeaders } = require('./redact');
const { matchRoute, upstreamPath, singleRoute } = require('./routes');

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/;

// SSE responses never send `end` promptly, so they take a chunk-aware path:
// chunks are streamed to the client as they arrive and stored in order.
function isEventStream(contentType) {
  return (contentType || '').toLowerCase().includes('text/event-stream');
}

// A recorded inter-chunk gap is kept for replay fidelity but capped so a
// stalled upstream cannot make cassettes replay arbitrary pauses.
const MAX_RECORDED_DELAY_MS = 5000;

// HOP_BY_HOP headers must not be forwarded or replayed.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function isTextual(contentType) {
  return !contentType || TEXTUAL.test(contentType);
}

function forwardRequest(target, req, body, upstreamPathValue, callback) {
  const transport = target.protocol === 'https:' ? https : http;
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name)) headers[name] = value;
  }
  headers.host = target.host;
  const upstream = transport.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: upstreamPathValue,
      method: req.method,
      headers,
    },
    callback
  );
  upstream.on('error', () => callback(null));
  upstream.end(body);
}

function filterUpstreamHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && name !== 'content-encoding') out[name] = value;
  }
  return out;
}

function saveExchange(dir, req, reqBody, status, resHeaders, resBody, resType, stream, upstreamMeta) {
  const reqType = req.headers['content-type'] || '';
  const cassette = {
    request: {
      method: req.method,
      path: req.url,
      headers: redactHeaders(req.headers),
      body: isTextual(reqType) ? reqBody.toString('utf8') : reqBody.toString('base64'),
      bodyEncoding: isTextual(reqType) ? 'utf8' : 'base64',
    },
    response: {
      status,
      headers: redactHeaders(resHeaders),
      body: isTextual(resType) ? resBody.toString('utf8') : resBody.toString('base64'),
      bodyEncoding: isTextual(resType) ? 'utf8' : 'base64',
    },
    recordedAt: new Date().toISOString(),
  };
  if (stream) {
    // Keep the joined body readable for check/diff, and the ordered chunks
    // so serve can replay the stream framing instead of one buffered write.
    cassette.response.stream = true;
    cassette.response.chunks = stream.chunks;
    if (stream.truncated) cassette.response.truncated = true;
  }
  // In multi-upstream sessions every cassette records which upstream it
  // came from, so serve/check can route and replay it correctly later.
  if (upstreamMeta) cassette.upstream = upstreamMeta;
  return saveCassette(dir, cassette);
}

// Streams a text/event-stream response through to the client while recording
// each chunk (with the gap since the previous chunk) in arrival order. The
// cassette is written when the upstream closes the stream, or as `truncated`
// when the upstream dies mid-stream.
function recordEventStream(upstream, req, reqBody, res, dir, upstreamMeta, onSaved) {
  const resHeaders = filterUpstreamHeaders(upstream.headers);
  res.writeHead(upstream.statusCode, resHeaders);

  const chunks = [];
  let lastAt = process.hrtime.bigint();
  upstream.on('data', (c) => {
    const now = process.hrtime.bigint();
    const delayMs = Number((now - lastAt) / 1000000n);
    lastAt = now;
    chunks.push({ data: c.toString('utf8'), encoding: 'utf8', delayMs: Math.min(delayMs, MAX_RECORDED_DELAY_MS) });
    res.write(c);
  });

  let saved = false;
  const finish = (truncated) => {
    if (saved) return;
    saved = true;
    res.end();
    const resBody = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'utf8')));
    const resType = upstream.headers['content-type'] || '';
    const file = saveExchange(
      dir,
      req,
      reqBody,
      upstream.statusCode,
      resHeaders,
      resBody,
      resType,
      { chunks, truncated },
      upstreamMeta
    );
    onSaved();
    console.log(`recorded ${req.method} ${req.url} -> ${upstream.statusCode} (stream, ${chunks.length} chunks${truncated ? ', truncated' : ''})  (${file})`);
  };
  upstream.on('end', () => finish(false));
  upstream.on('aborted', () => finish(true));
  upstream.on('error', () => finish(true));
  res.on('close', () => {
    // Client went away mid-stream: keep what arrived as a truncated cassette.
    if (!res.writableEnded) finish(true);
  });
}

function startRecorder({ target, routes, port, dir }) {
  // routes: [{ name, url: URL, prefix }] from src/routes. A plain `target`
  // string keeps the original single-upstream behaviour.
  const table = routes || singleRoute(target);
  const multi = table.length > 1;
  let count = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reqBody = Buffer.concat(chunks);
      const route = matchRoute(table, req.url);
      if (!route) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: `mock-anything has no route for ${req.url}`,
          routes: table.map((r) => (r.prefix ? `${r.prefix} -> ${r.url.href}` : r.url.href)),
        }));
        return;
      }
      const upPath = upstreamPath(route, req.url);
      const upstreamMeta = multi
        ? { name: route.name, target: route.url.href, prefix: route.prefix, path: upPath }
        : undefined;
      forwardRequest(route.url, req, reqBody, upPath, (upstream) => {
        if (!upstream) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `mock-anything could not reach ${route.url.href}` }));
          return;
        }
        const resType = upstream.headers['content-type'] || '';
        if (isEventStream(resType)) {
          recordEventStream(upstream, req, reqBody, res, dir, upstreamMeta, () => count += 1);
          return;
        }
        const resChunks = [];
        upstream.on('data', (c) => resChunks.push(c));
        upstream.on('end', () => {
          // Store the response decoded: cassettes stay plain, readable JSON
          // and replay never depends on transfer encodings.
          let resBody = Buffer.concat(resChunks);
          const encoding = upstream.headers['content-encoding'];
          try {
            if (encoding === 'gzip') resBody = zlib.gunzipSync(resBody);
            else if (encoding === 'deflate') resBody = zlib.inflateSync(resBody);
            else if (encoding === 'br') resBody = zlib.brotliDecompressSync(resBody);
          } catch {
            // keep the raw bytes if decoding fails
          }
          const resHeaders = filterUpstreamHeaders(upstream.headers);
          res.writeHead(upstream.statusCode, resHeaders);
          res.end(resBody);
          const file = saveExchange(dir, req, reqBody, upstream.statusCode, resHeaders, resBody, resType, undefined, upstreamMeta);
          count += 1;
          console.log(`recorded ${req.method} ${req.url} -> ${upstream.statusCode}  (${file})`);
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => reject(friendlyListenError(err, port)));
    server.listen(port, () => {
      console.log(`mock-anything record: forwarding http://localhost:${port}`);
      for (const r of table) {
        console.log(`  ${r.prefix ? `${r.prefix} -> ` : ''}${r.url.href}${r.name ? `  (${r.name})` : '  (default)'}`);
      }
      console.log(`point your app's API base URL at http://localhost:${port} and exercise it. Ctrl-C to stop.`);
      resolve({ server, count: () => count, routes: table });
    });
  });
}

module.exports = { startRecorder, HOP_BY_HOP, isTextual, isEventStream };
