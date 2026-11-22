'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { loadCassettes, decodeBody } = require('./cassettes');

// A live event stream may never close; check waits at most this long for it
// and then diffs what arrived. Override with MOCK_ANYTHING_STREAM_TIMEOUT_MS.
function streamTimeoutMs() {
  const raw = process.env.MOCK_ANYTHING_STREAM_TIMEOUT_MS;
  if (raw === undefined) return 30000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

// Replays every recorded request against the live API and diffs the answers
// against the cassettes. Catches API drift: your mocks quietly going stale.
function fetchLive(target, cassette, livePath) {
  return new Promise((resolve) => {
    const path = livePath || cassette.request.path;
    const transport = target.protocol === 'https:' ? https : http;
    const body = decodeBody(cassette.request);
    const headers = { ...cassette.request.headers, host: target.host };
    // Never send the redacted placeholder upstream, and ask for an
    // identity response so comparison happens on readable bytes.
    for (const [name, value] of Object.entries(headers)) {
      if (value === '<redacted>') delete headers[name];
    }
    delete headers['accept-encoding'];
    if (body.length > 0) headers['content-length'] = body.length;
    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path,
        method: cassette.request.method,
        headers,
      },
      (res) => {
        const chunks = [];
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          let body = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          try {
            if (encoding === 'gzip') body = zlib.gunzipSync(body);
            else if (encoding === 'deflate') body = zlib.inflateSync(body);
            else if (encoding === 'br') body = zlib.brotliDecompressSync(body);
          } catch {
            // compare raw bytes if decoding fails
          }
          resolve({ status: res.statusCode, body });
        };
        res.on('data', (c) => chunks.push(c));
        res.on('end', finish);
        res.on('error', finish);
        if (cassette.response.stream) {
          // A stream that never ends must not hang check forever.
          const timer = setTimeout(finish, streamTimeoutMs());
          res.on('end', () => clearTimeout(timer));
          res.on('error', () => clearTimeout(timer));
        }
      }
    );
    req.on('error', (err) => resolve({ status: 0, body: Buffer.from(String(err)) }));
    req.end(body);
  });
}

function diffJson(recorded, live, path = '$') {
  const diffs = [];
  if (typeof recorded !== typeof live || recorded === null || live === null ||
      Array.isArray(recorded) !== Array.isArray(live)) {
    diffs.push(`${path}: ${JSON.stringify(recorded)} -> ${JSON.stringify(live)}`);
    return diffs;
  }
  if (typeof recorded === 'object') {
    if (Array.isArray(recorded)) {
      if (recorded.length !== live.length) {
        diffs.push(`${path}: array length ${recorded.length} -> ${live.length}`);
      }
      for (let i = 0; i < Math.min(recorded.length, live.length); i++) {
        diffs.push(...diffJson(recorded[i], live[i], `${path}[${i}]`));
      }
      return diffs;
    }
    for (const key of new Set([...Object.keys(recorded), ...Object.keys(live)])) {
      if (!(key in recorded)) diffs.push(`${path}.${key}: added in live response`);
      else if (!(key in live)) diffs.push(`${path}.${key}: missing from live response`);
      else diffs.push(...diffJson(recorded[key], live[key], `${path}.${key}`));
    }
    return diffs;
  }
  if (recorded !== live) diffs.push(`${path}: ${JSON.stringify(recorded)} -> ${JSON.stringify(live)}`);
  return diffs;
}

function diffBodies(recordedEntry, liveBody) {
  const recordedBody = decodeBody(recordedEntry).toString('utf8');
  const liveText = liveBody.toString('utf8');
  const type = recordedEntry.headers && recordedEntry.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try {
      return diffJson(JSON.parse(recordedBody), JSON.parse(liveText));
    } catch {
      // fall through to byte comparison
    }
  }
  if (recordedEntry.stream) {
    // Event streams drift on content, not on how the server happened to
    // split the bytes into chunks, so compare the joined text.
    return recordedBody === liveText ? [] : ['event stream body differs'];
  }
  return recordedBody === liveText ? [] : ['body differs (non-JSON response)'];
}

async function runCheck({ target, dir }) {
  const cassettes = loadCassettes(dir);
  if (cassettes.length === 0) {
    throw new Error(`no cassettes found in ${dir}/cassettes`);
  }
  // Cassettes from a multi-upstream recording carry their own target; a plain
  // --target is only needed for cassettes recorded the old single-target way.
  const missing = cassettes.filter((c) => !c.upstream).length;
  if (!target && missing > 0) {
    throw new Error(`check needs --target <url>: ${missing} cassette(s) do not record which upstream they came from`);
  }
  const targetUrl = target ? new URL(target) : null;
  const targets = [...new Set(cassettes.map((c) => (c.upstream ? c.upstream.target : target)).filter(Boolean))];
  console.log(`mock-anything check: replaying ${cassettes.length} recorded requests against ${targets.join(', ')}`);

  let drifted = 0;
  for (const cassette of cassettes) {
    const up = cassette.upstream || null;
    const liveTarget = up ? new URL(up.target) : targetUrl;
    // Replay against the path the upstream actually saw (local prefix stripped).
    const livePath = up && up.path ? up.path : cassette.request.path;
    const live = await fetchLive(liveTarget, cassette, livePath);
    const tag = up ? ` [${up.name || 'default'}]` : '';
    const label = `${cassette.request.method} ${cassette.request.path}${tag}${cassette.response.stream ? ' (stream)' : ''}`;
    if (live.status !== cassette.response.status) {
      drifted += 1;
      console.log(`DRIFT ${label}: status ${cassette.response.status} -> ${live.status || 'request failed'}`);
      continue;
    }
    const diffs = diffBodies(cassette.response, live.body);
    if (diffs.length > 0) {
      drifted += 1;
      console.log(`DRIFT ${label}:`);
      for (const d of diffs.slice(0, 10)) console.log(`  ${d}`);
      if (diffs.length > 10) console.log(`  ... and ${diffs.length - 10} more`);
    } else {
      console.log(`OK    ${label}`);
    }
  }

  console.log('');
  if (drifted === 0) {
    console.log(`in sync: all ${cassettes.length} recordings still match the live API`);
    return 0;
  }
  console.log(`${drifted}/${cassettes.length} recordings have drifted - re-record to refresh your mocks`);
  process.exitCode = 1;
  return 1;
}

module.exports = { runCheck, diffJson };
