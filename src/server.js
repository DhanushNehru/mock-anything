'use strict';

const http = require('http');
const { loadCassettes, matchKey, decodeBody } = require('./cassettes');
const { HOP_BY_HOP } = require('./recorder');

// Serves recorded responses only. This server has no code path that talks
// to the recorded API: unmatched requests fail loudly instead of falling
// through to the network.
function startMockServer({ port, dir }) {
  const cassettes = loadCassettes(dir);
  if (cassettes.length === 0) {
    throw new Error(`no cassettes found in ${dir}/cassettes - run "mock-anything record" first`);
  }

  // Queue per match key: repeated identical requests replay in recorded order.
  const queues = new Map();
  for (const cassette of cassettes) {
    if (!queues.has(cassette.key)) queues.set(cassette.key, []);
    queues.get(cassette.key).push(cassette);
  }
  const hits = new Map();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const key = matchKey(req.method, req.url, body, req.headers['content-type']);
      const queue = queues.get(key);

      if (!queue || queue.length === 0) {
        const known = [...new Set(cassettes.map((c) => `${c.request.method} ${c.request.path}`))];
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: `mock-anything has no recording for ${req.method} ${req.url}`,
          hint: 'record this interaction first, or check the request body matches the recording',
          recorded: known,
        }));
        return;
      }

      // Keep the last cassette in the queue so idempotent calls keep working.
      const cassette = queue.length > 1 ? queue.shift() : queue[0];
      hits.set(cassette.file, (hits.get(cassette.file) || 0) + 1);

      const headers = {};
      for (const [name, value] of Object.entries(cassette.response.headers)) {
        if (!HOP_BY_HOP.has(name)) headers[name] = value;
      }
      const payload = decodeBody(cassette.response);
      headers['content-length'] = payload.length;
      headers['x-mock-anything'] = cassette.file;
      res.writeHead(cassette.response.status, headers);
      res.end(payload);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      resolve({
        server,
        stats: () => ({
          total: cassettes.length,
          hit: [...hits.keys()].length,
          unused: cassettes.filter((c) => !hits.has(c.file)).map((c) => c.file),
        }),
      });
    });
  });
}

module.exports = { startMockServer };
