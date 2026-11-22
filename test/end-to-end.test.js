'use strict';

// Full loop against a throwaway local API: record through the proxy, shut
// the API down, then prove the mock server answers the same bytes with no
// upstream to talk to.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startRecorder } = require('../src/recorder');
const { startMockServer } = require('../src/server');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    }).on('error', reject);
  });
}

function post(port, p, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

function fakeApi() {
  return http.createServer((req, res) => {
    if (req.url === '/api/user/7') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 7, name: 'Ada', plan: 'pro' }));
    } else if (req.url === '/api/echo' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    }
  });
}

test('record then serve replays identical responses with the API offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-'));
  const api = fakeApi();
  await new Promise((r) => api.listen(0, r));
  const apiPort = api.address().port;

  const recorder = await startRecorder({ target: `http://127.0.0.1:${apiPort}`, port: 0, dir });
  const recordPort = recorder.server.address().port;

  const liveGet = await get(recordPort, '/api/user/7');
  const livePost = await post(recordPort, '/api/echo', { hello: 'world', n: 1 });
  assert.equal(liveGet.status, 200);
  assert.equal(livePost.status, 201);

  // The API is gone from here on: everything below runs offline.
  api.close();
  recorder.server.close();

  const mock = await startMockServer({ port: 0, dir });
  const mockPort = mock.server.address().port;

  const mockedGet = await get(mockPort, '/api/user/7');
  assert.equal(mockedGet.status, 200);
  assert.deepEqual(JSON.parse(mockedGet.body), { id: 7, name: 'Ada', plan: 'pro' });

  const mockedPost = await post(mockPort, '/api/echo', { n: 1, hello: 'world' }); // key order differs
  assert.equal(mockedPost.status, 201);
  assert.deepEqual(JSON.parse(mockedPost.body), { echoed: { hello: 'world', n: 1 } });

  const missing = await get(mockPort, '/api/never-recorded');
  assert.equal(missing.status, 502);
  assert.match(missing.body, /no recording/);

  mock.server.close();
});

test('sensitive headers are redacted in cassettes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-'));
  const api = fakeApi();
  await new Promise((r) => api.listen(0, r));
  const apiPort = api.address().port;

  const recorder = await startRecorder({ target: `http://127.0.0.1:${apiPort}`, port: 0, dir });
  const recordPort = recorder.server.address().port;

  await new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: recordPort, path: '/api/user/7', headers: { authorization: 'Bearer secret-token' } },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', reject);
  });

  api.close();
  recorder.server.close();

  const raw = fs.readdirSync(path.join(dir, 'cassettes')).map((f) =>
    fs.readFileSync(path.join(dir, 'cassettes', f), 'utf8')
  ).join('\n');
  assert.ok(!raw.includes('secret-token'), 'cassette must not contain the token');
  assert.ok(raw.includes('<redacted>'));
});
