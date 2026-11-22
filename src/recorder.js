'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { saveCassette } = require('./cassettes');
const { friendlyListenError } = require('./errors');
const { redactHeaders } = require('./redact');

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/;

// HOP_BY_HOP headers must not be forwarded or replayed.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function isTextual(contentType) {
  return !contentType || TEXTUAL.test(contentType);
}

function forwardRequest(target, req, body, callback) {
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
      path: req.url,
      method: req.method,
      headers,
    },
    callback
  );
  upstream.on('error', () => callback(null));
  upstream.end(body);
}

function startRecorder({ target, port, dir }) {
  const targetUrl = new URL(target);
  let count = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reqBody = Buffer.concat(chunks);
      forwardRequest(targetUrl, req, reqBody, (upstream) => {
        if (!upstream) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `mock-anything could not reach ${target}` }));
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
          const resHeaders = {};
          for (const [name, value] of Object.entries(upstream.headers)) {
            if (!HOP_BY_HOP.has(name) && name !== 'content-encoding') resHeaders[name] = value;
          }
          res.writeHead(upstream.statusCode, resHeaders);
          res.end(resBody);

          const reqType = req.headers['content-type'] || '';
          const resType = upstream.headers['content-type'] || '';
          const cassette = {
            request: {
              method: req.method,
              path: req.url,
              headers: redactHeaders(req.headers),
              body: isTextual(reqType) ? reqBody.toString('utf8') : reqBody.toString('base64'),
              bodyEncoding: isTextual(reqType) ? 'utf8' : 'base64',
            },
            response: {
              status: upstream.statusCode,
              headers: redactHeaders(resHeaders),
              body: isTextual(resType) ? resBody.toString('utf8') : resBody.toString('base64'),
              bodyEncoding: isTextual(resType) ? 'utf8' : 'base64',
            },
            recordedAt: new Date().toISOString(),
          };
          const file = saveCassette(dir, cassette);
          count += 1;
          console.log(`recorded ${req.method} ${req.url} -> ${upstream.statusCode}  (${file})`);
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => reject(friendlyListenError(err, port)));
    server.listen(port, () => {
      console.log(`mock-anything record: forwarding http://localhost:${port} -> ${target}`);
      console.log(`point your app's API base URL at http://localhost:${port} and exercise it. Ctrl-C to stop.`);
      resolve({ server, count: () => count });
    });
  });
}

module.exports = { startRecorder, HOP_BY_HOP, isTextual };
