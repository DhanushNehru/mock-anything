'use strict';

// Server-Sent Events: the recorder must stream a text/event-stream response
// through while recording its chunks, and `serve` must replay the same
// chunk framing instead of one buffered write.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startRecorder } = require('../src/recorder');
const { startMockServer } = require('../src/server');
const { loadCassettes } = require('../src/cassettes');

const EVENTS = ['data: {"n":1}\n\n', 'data: {"n":2}\n\n', 'event: done\ndata: bye\n\n'];

function sseApi() {
  return http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let i = 0;
      const timer = setInterval(() => {
        res.write(EVENTS[i++]);
        if (i >= EVENTS.length) {
          clearInterval(timer);
          res.end();
        }
      }, 40);
      req.on('close', () => clearInterval(timer));
    } else if (req.url === '/api/user/7') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 7, name: 'Ada' }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    }
  });
}

// GET that resolves with the list of raw chunks the client saw, so the test
// can assert on chunk boundaries, not just the joined body.
function getStream(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks }));
    }).on('error', reject);
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    }).on('error', reject);
  });
}

test('SSE responses are streamed through the recorder and stored as ordered chunks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-sse-'));
  const api = sseApi();
  await new Promise((r) => api.listen(0, r));
  const apiPort = api.address().port;

  const recorder = await startRecorder({ target: `http://127.0.0.1:${apiPort}`, port: 0, dir });
  const recordPort = recorder.server.address().port;
  t.after(() => { api.close(); recorder.server.close(); });

  // While recording, the client must see the events arrive one by one,
  // not in a single buffered write at the end.
  const live = await getStream(recordPort, '/events');
  assert.equal(live.status, 200);
  assert.match(live.headers['content-type'], /text\/event-stream/);
  assert.equal(live.chunks.length, EVENTS.length, `expected ${EVENTS.length} chunks while recording, got ${live.chunks.length}`);
  assert.deepEqual(live.chunks, EVENTS);

  // A normal buffered endpoint on the same recorder is unaffected.
  const normal = await get(recordPort, '/api/user/7');
  assert.equal(normal.status, 200);
  assert.deepEqual(JSON.parse(normal.body), { id: 7, name: 'Ada' });

  // The cassette stays readable JSON and records the chunk boundaries.
  const cassettes = loadCassettes(dir);
  const sse = cassettes.find((c) => c.request.path === '/events');
  assert.ok(sse, 'an /events cassette must exist');
  assert.equal(sse.response.stream, true);
  assert.equal(sse.response.chunks.length, EVENTS.length);
  assert.deepEqual(sse.response.chunks.map((c) => c.data), EVENTS);
  assert.equal(sse.response.body, EVENTS.join(''), 'joined body stays readable for check/diff');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'cassettes', sse.file), 'utf8'));
  assert.equal(onDisk.response.stream, true, 'cassette on disk is plain JSON with the stream marker');
});

test('serve replays an SSE cassette with the same chunk framing and order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-sse-'));
  const api = sseApi();
  await new Promise((r) => api.listen(0, r));
  const apiPort = api.address().port;

  const recorder = await startRecorder({ target: `http://127.0.0.1:${apiPort}`, port: 0, dir });
  const recordPort = recorder.server.address().port;
  await get(recordPort, '/events');
  await get(recordPort, '/api/user/7');

  // The API is gone from here on: everything below runs offline.
  api.close();
  recorder.server.close();

  const mock = await startMockServer({ port: 0, dir });
  const mockPort = mock.server.address().port;
  t.after(() => mock.server.close());

  const replayed = await getStream(mockPort, '/events');
  assert.equal(replayed.status, 200);
  assert.match(replayed.headers['content-type'], /text\/event-stream/);
  assert.equal(replayed.chunks.length, EVENTS.length, `replay must keep ${EVENTS.length} chunks, got ${replayed.chunks.length}`);
  assert.deepEqual(replayed.chunks, EVENTS);
  assert.equal(replayed.chunks.join(''), EVENTS.join(''));

  // Buffered responses still arrive as one payload with content-length.
  const normal = await get(mockPort, '/api/user/7');
  assert.equal(normal.status, 200);
  assert.deepEqual(JSON.parse(normal.body), { id: 7, name: 'Ada' });
  assert.ok(normal.headers['content-length'], 'buffered responses keep content-length');
});

test('serve streams a hand-written chunked cassette without a recorder round-trip', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-sse-'));
  fs.mkdirSync(path.join(dir, 'cassettes'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cassettes', '0001-get-events.json'),
    JSON.stringify({
      request: { method: 'GET', path: '/events', headers: {}, body: '', bodyEncoding: 'utf8' },
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: a\n\ndata: b\n\n',
        bodyEncoding: 'utf8',
        stream: true,
        chunks: [
          { data: 'data: a\n\n', encoding: 'utf8', delayMs: 30 },
          { data: 'data: b\n\n', encoding: 'utf8', delayMs: 0 },
        ],
      },
      recordedAt: new Date().toISOString(),
    }, null, 2)
  );

  const mock = await startMockServer({ port: 0, dir });
  const mockPort = mock.server.address().port;
  t.after(() => mock.server.close());
  const replayed = await getStream(mockPort, '/events');
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.chunks, ['data: a\n\n', 'data: b\n\n']);
});
