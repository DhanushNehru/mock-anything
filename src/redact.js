'use strict';

// Headers that never belong in a committed cassette. Values are replaced
// with "<redacted>" during recording. Extend with MOCK_ANYTHING_REDACT,
// a comma-separated list of extra header names.
const DEFAULT_REDACTED = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
]);

function redactSet() {
  const extra = (process.env.MOCK_ANYTHING_REDACT || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_REDACTED, ...extra]);
}

function redactHeaders(headers) {
  const sensitive = redactSet();
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name.toLowerCase()] = sensitive.has(name.toLowerCase()) ? '<redacted>' : value;
  }
  return out;
}

module.exports = { redactHeaders, redactSet };
