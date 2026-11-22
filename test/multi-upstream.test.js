'use strict';

// One recorder fronting several upstreams, routed by path prefix. Cassettes
// remember which upstream they came from so `serve` and `check` route and
// replay correctly. All servers are throwaway localhost servers: no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startRecorder } = require('../src/recorder');
const { startMockServer } = require('../src/server');
const { runCheck } = require('../src/check');
const { loadCassettes } = require('../src/cassettes');
const { buildRoutes, singleRoute, matchRoute, upstreamPath, describeRoutes } = require('../src/routes');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    }).on('error', reject);
  });
}

// A fake upstream that answers /ping with its name and records what it got.
function fakeUpstream(name, seen) {
  return http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ upstream: name }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope', upstream: name, path: req.url }));
    }
  });
}

function listen(server) {
  return new Promise((r) => server.listen(0, r));
}

test('buildRoutes parses named targets with prefixes and keeps a default route', () => {
  const routes = buildRoutes({
    targets: ['api=https://api.example.com', 'https://default.example.com', 'auth=https://auth.example.com'],
    prefixes: ['api=/stripe', '/auth'],
  });
  assert.equal(routes.length, 3);
  const api = routes.find((r) => r.name === 'api');
  assert.equal(api.url.host, 'api.example.com');
  assert.equal(api.prefix, '/stripe');
  const auth = routes.find((r) => r.name === 'auth');
  assert.equal(auth.prefix, '/auth', 'a bare --prefix binds to the preceding --target');
  const def = routes.find((r) => !r.name);
  assert.equal(def.prefix, null);
  assert.equal(def.url.host, 'default.example.com');
});

test('buildRoutes rejects bad flag combinations', () => {
  assert.throws(() => buildRoutes({ targets: [] }), /at least one --target/);
  assert.throws(() => buildRoutes({ targets: ['api=https://a.example.com'] }), /needs a prefix/);
  assert.throws(
    () => buildRoutes({ targets: ['api=https://a.example.com', 'api=https://b.example.com'], prefixes: ['api=/x'] }),
    /duplicate --target name/
  );
  assert.throws(() => buildRoutes({ targets: ['https://a.example.com', 'https://b.example.com'] }), /at most one plain --target/);
  assert.throws(() => buildRoutes({ targets: ['https://a.example.com'], prefixes: ['noslash'] }), /must look like/);
  assert.throws(() => buildRoutes({ targets: ['https://a.example.com'], prefixes: ['ghost=/x'] }), /no --target named "ghost"/);
  assert.throws(() => buildRoutes({ targets: ['ftp://x'] }), /http\(s\)/);
});

test('matchRoute picks the longest prefix and never matches a string-extension sibling', () => {
  const routes = buildRoutes({
    targets: ['https://default.example.com', 'api=https://api.example.com', 'long=https://long.example.com'],
    prefixes: ['api=/api', 'long=/api/deep'],
  });
  assert.equal(matchRoute(routes, '/api/x').name, 'api');
  assert.equal(matchRoute(routes, '/api/deep/x').name, 'long');
  assert.equal(matchRoute(routes, '/apix').prefix, null, '/apix must fall to the default route, not /api');
  assert.equal(matchRoute(routes, '/other').prefix, null);
  assert.equal(upstreamPath(matchRoute(routes, '/api/v1/charges'), '/api/v1/charges'), '/v1/charges');
  assert.equal(upstreamPath(matchRoute(routes, '/api'), '/api'), '/');
  assert.equal(upstreamPath(matchRoute(routes, '/other'), '/other'), '/other');
  assert.match(describeRoutes(singleRoute('https://x.example.com')), /default/);
});

test('one recorder fronts two upstreams; cassettes record the upstream; serve replays both', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-multi-'));
  const seenStripe = [];
  const seenAuth = [];
  const stripe = fakeUpstream('stripe', seenStripe);
  const auth = fakeUpstream('auth', seenAuth);
  await listen(stripe);
  await listen(auth);
  t.after(() => { stripe.close(); auth.close(); });

  const routes = buildRoutes({
    targets: [
      `api=http://127.0.0.1:${stripe.address().port}`,
      `auth=http://127.0.0.1:${auth.address().port}`,
    ],
    prefixes: ['api=/stripe', 'auth=/auth'],
  });
  const recorder = await startRecorder({ routes, port: 0, dir });
  const recordPort = recorder.server.address().port;
  t.after(() => recorder.server.close());

  const r1 = await get(recordPort, '/stripe/ping');
  assert.equal(r1.status, 200);
  assert.deepEqual(JSON.parse(r1.body), { upstream: 'stripe' });
  const r2 = await get(recordPort, '/auth/ping');
  assert.deepEqual(JSON.parse(r2.body), { upstream: 'auth' });

  // Prefixes are stripped before forwarding.
  assert.deepEqual(seenStripe, ['GET /ping']);
  assert.deepEqual(seenAuth, ['GET /ping']);

  // No route matches: a loud 502 naming the routes, never a silent fallthrough.
  const r3 = await get(recordPort, '/nowhere/ping');
  assert.equal(r3.status, 502);
  assert.match(r3.body, /no route/);
  assert.match(r3.body, /\/stripe/);
  assert.match(r3.body, /\/auth/);

  const cassettes = loadCassettes(dir);
  const cStripe = cassettes.find((c) => c.request.path === '/stripe/ping');
  const cAuth = cassettes.find((c) => c.request.path === '/auth/ping');
  assert.equal(cStripe.upstream.name, 'api');
  assert.equal(cStripe.upstream.prefix, '/stripe');
  assert.equal(cStripe.upstream.path, '/ping', 'cassette stores the stripped upstream path');
  assert.match(cStripe.upstream.target, /127\.0\.0\.1/);
  assert.equal(cAuth.upstream.name, 'auth');

  // Upstreams are gone: replay both from cassettes offline.
  stripe.close();
  auth.close();
  recorder.server.close();

  const mock = await startMockServer({ port: 0, dir });
  const mockPort = mock.server.address().port;
  t.after(() => mock.server.close());

  const m1 = await get(mockPort, '/stripe/ping');
  const m2 = await get(mockPort, '/auth/ping');
  assert.deepEqual(JSON.parse(m1.body), { upstream: 'stripe' });
  assert.deepEqual(JSON.parse(m2.body), { upstream: 'auth' });
  assert.equal(m1.headers['x-mock-anything'], cStripe.file);
  const m3 = await get(mockPort, '/nowhere/ping');
  assert.equal(m3.status, 502);
});

test('a default route alongside a named one keeps single-target behaviour for other paths', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-multi-'));
  const seenDefault = [];
  const seenApi = [];
  const def = fakeUpstream('default', seenDefault);
  const api = fakeUpstream('api', seenApi);
  await listen(def);
  await listen(api);
  t.after(() => { def.close(); api.close(); });

  const routes = buildRoutes({
    targets: [`http://127.0.0.1:${def.address().port}`, `api=http://127.0.0.1:${api.address().port}`],
    prefixes: ['api=/api'],
  });
  const recorder = await startRecorder({ routes, port: 0, dir });
  const recordPort = recorder.server.address().port;
  t.after(() => recorder.server.close());

  await get(recordPort, '/api/ping');
  await get(recordPort, '/ping');
  assert.deepEqual(seenApi, ['GET /ping']);
  assert.deepEqual(seenDefault, ['GET /ping']);

  const cassettes = loadCassettes(dir);
  const cApi = cassettes.find((c) => c.request.path === '/api/ping');
  const cDef = cassettes.find((c) => c.request.path === '/ping');
  assert.equal(cApi.upstream.name, 'api');
  assert.equal(cDef.upstream.name, null, 'default-route cassettes still record their target in multi mode');
  assert.equal(cDef.upstream.prefix, null);
  assert.equal(cDef.upstream.path, '/ping');
});

test('single-target recording keeps cassettes free of the upstream field', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-single-'));
  const seen = [];
  const api = fakeUpstream('solo', seen);
  await listen(api);
  t.after(() => api.close());

  const recorder = await startRecorder({ target: `http://127.0.0.1:${api.address().port}`, port: 0, dir });
  t.after(() => recorder.server.close());
  await get(recorder.server.address().port, '/ping');

  const cassettes = loadCassettes(dir);
  assert.equal(cassettes.length, 1);
  assert.ok(!('upstream' in cassettes[0]), 'single-target cassettes stay byte-compatible with the old format');
});

test('check replays each cassette against its own upstream without --target', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-check-'));
  const seenStripe = [];
  const seenAuth = [];
  const stripe = fakeUpstream('stripe', seenStripe);
  const auth = fakeUpstream('auth', seenAuth);
  await listen(stripe);
  await listen(auth);
  t.after(() => { stripe.close(); auth.close(); });

  const routes = buildRoutes({
    targets: [
      `api=http://127.0.0.1:${stripe.address().port}`,
      `auth=http://127.0.0.1:${auth.address().port}`,
    ],
    prefixes: ['api=/stripe', 'auth=/auth'],
  });
  const recorder = await startRecorder({ routes, port: 0, dir });
  t.after(() => recorder.server.close());
  const recordPort = recorder.server.address().port;
  await get(recordPort, '/stripe/ping');
  await get(recordPort, '/auth/ping');
  recorder.server.close();

  // Both upstreams are live again for check; no --target flag at all.
  seenStripe.length = 0;
  seenAuth.length = 0;
  const code = await runCheck({ dir });
  assert.equal(code, 0, 'no drift expected');
  assert.deepEqual(seenStripe, ['GET /ping'], 'check sent the stripped path to the stripe upstream');
  assert.deepEqual(seenAuth, ['GET /ping'], 'check sent the stripped path to the auth upstream');
});

test('check still requires --target when cassettes carry no upstream info', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-anything-check2-'));
  const seen = [];
  const api = fakeUpstream('solo', seen);
  await listen(api);
  t.after(() => api.close());
  const recorder = await startRecorder({ target: `http://127.0.0.1:${api.address().port}`, port: 0, dir });
  t.after(() => recorder.server.close());
  await get(recorder.server.address().port, '/ping');
  recorder.server.close();

  await assert.rejects(() => runCheck({ dir }), /--target/);
  seen.length = 0; // drop the recording-time hit
  const code = await runCheck({ dir, target: `http://127.0.0.1:${api.address().port}` });
  assert.equal(code, 0);
  assert.deepEqual(seen, ['GET /ping']);
});
