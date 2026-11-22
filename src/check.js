'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { loadCassettes, decodeBody } = require('./cassettes');

// Replays every recorded request against the live API and diffs the answers
// against the cassettes. Catches API drift: your mocks quietly going stale.
function fetchLive(target, cassette) {
  return new Promise((resolve) => {
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
        path: cassette.request.path,
        method: cassette.request.method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
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
        });
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
  return recordedBody === liveText ? [] : ['body differs (non-JSON response)'];
}

async function runCheck({ target, dir }) {
  const targetUrl = new URL(target);
  const cassettes = loadCassettes(dir);
  if (cassettes.length === 0) {
    throw new Error(`no cassettes found in ${dir}/cassettes`);
  }
  console.log(`mock-anything check: replaying ${cassettes.length} recorded requests against ${target}`);

  let drifted = 0;
  for (const cassette of cassettes) {
    const live = await fetchLive(targetUrl, cassette);
    const label = `${cassette.request.method} ${cassette.request.path}`;
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
