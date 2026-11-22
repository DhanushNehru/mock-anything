# Cassette format reference

One cassette is one recorded HTTP exchange, stored as one JSON file. This page
documents exactly what `mock-anything` writes today, so you can hand-write,
generate, or post-process cassettes without reading `src/cassettes.js`.

## File location and naming

- Directory: `<dir>/cassettes/`, where `--dir` defaults to `./mocks`.
- File name: `NNNN-<method>-<slug>.json`, e.g. `0001-get-posts-1.json`.
  - `NNNN` is a 4-digit sequence number, incremented per saved cassette.
  - `<slug>` is the request path with every non-alphanumeric run replaced by
    `-`, trimmed of leading/trailing dashes, lowercased, capped at 60 chars
    (`/` becomes `root`).
- Files are pretty-printed JSON (2-space indent) with a trailing newline.

## Top-level fields

| field | type | required | meaning |
|---|---|---|---|
| `request` | object | yes | the recorded request (below) |
| `response` | object | yes | the recorded response (below) |
| `recordedAt` | string | yes | ISO 8601 UTC timestamp of when the exchange was recorded, e.g. `"2026-11-22T06:30:07.085Z"` |
| `upstream` | object | no | only on cassettes from a multi-upstream `record` session: `{ "name", "target", "prefix", "path" }` — which upstream the request was routed to and the path after the prefix. **HAR import does not store `upstream` metadata.** |

`file` and `key` are added in memory by `list`/`serve`; they are not stored in
the file.

## `request`

| field | type | meaning |
|---|---|---|
| `method` | string | HTTP method, uppercase, e.g. `"GET"`, `"POST"` |
| `path` | string | path **with query string**, exactly as received, e.g. `"/posts?_limit=1"` |
| `headers` | object | header names lowercased; sensitive values replaced with `"<redacted>"` (see below) |
| `body` | string | request body; see `bodyEncoding` |
| `bodyEncoding` | `"utf8"` \| `"base64"` | `utf8` for textual content types, `base64` for everything else |

## `response`

| field | type | meaning |
|---|---|---|
| `status` | number | HTTP status code, e.g. `200` |
| `headers` | object | **required** — response headers, lowercased, hop-by-hop headers dropped, sensitive values `"<redacted>"`. `serve` reads this field directly and crashes on a cassette without it; use `{}` when the response had no headers worth keeping. |
| `body` | string | response body; joined text for streams (see `chunks`) |
| `bodyEncoding` | `"utf8"` \| `"base64"` | same rule as the request body |
| `stream` | `true` | optional; present only for `text/event-stream` responses |
| `chunks` | array | optional, with `stream`; ordered SSE chunks, each `{ "data": string, "encoding": "utf8", "delayMs": number }` (`delayMs` is the recorded gap before the chunk, capped) |
| `truncated` | `true` | optional, with `stream`; set when the upstream died mid-stream |

## Redaction

These header values are always stored as `"<redacted>"` on both request and
response: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
`x-api-key`, `api-key`, `apikey`, `x-auth-token`, `x-access-token`,
`x-csrf-token`. Add your own with `MOCK_ANYTHING_REDACT="x-tenant-secret,x-session"`.

## How `serve` matches a request to a cassette

The match key is `METHOD path :: sha256(canonicalBody).slice(0, 16)`:

- method and full path (with query) must match exactly;
- the request body is canonicalized first: for `application/json` bodies the
  JSON is parsed and all object keys are sorted recursively, so key order does
  not matter; other bodies match byte-for-byte;
- **headers are not part of matching**;
- repeated identical requests replay in recorded order (a FIFO queue per key).

Unmatched requests get a 502 listing the known keys; `serve` never touches the
network.

## Example

```json
{
  "request": {
    "method": "GET",
    "path": "/posts/1",
    "headers": { "accept": "application/json", "authorization": "<redacted>" },
    "body": "",
    "bodyEncoding": "utf8"
  },
  "response": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": "{\n  \"id\": 1,\n  \"title\": \"hello\"\n}",
    "bodyEncoding": "utf8"
  },
  "recordedAt": "2026-11-22T06:30:07.085Z"
}
```

The smallest hand-written cassette needs only `request.method`, `request.path`,
`response.status`, and `response.body` — headers, bodies and encodings default
sensibly when omitted. `mock-anything list --dir ./mocks` shows what a
directory contains; `mock-anything check --target <url>` replays cassettes
against the live API to detect drift.
