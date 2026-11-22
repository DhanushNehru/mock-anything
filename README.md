<p align="center"><b>Your tests don't need the real API. They need its answers.</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933" alt="Node 18+">
  <img src="https://img.shields.io/badge/dependencies-0-2563eb" alt="zero dependencies">
  <a href="https://github.com/DhanushNehru/mock-anything/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-555" alt="MIT"></a>
</p>

Suites that hit live third-party APIs are slow, flaky, rate-limited and useless on a plane. Hand-rolled mocks fix that and then quietly rot: the API changes, the mock doesn't, and your tests pass against a fiction.

**mock-anything** records your app's real HTTP traffic once, replays it from a local mock server forever, and proves two things: your suite passes with the network gone, and your recordings still match the live API. Zero dependencies, one binary, plain JSON cassettes you can diff and commit.

## Install

```sh
npm install -g mock-anything-cli
```

Or build from source:

```sh
git clone https://github.com/DhanushNehru/mock-anything.git
cd mock-anything && npm link        # or run bin/mock-anything.js directly
```

Requires Node.js 18 or later. Nothing else.

## Quickstart

Point your app at the recorder instead of the real API and run whatever exercises it:

```sh
mock-anything record --target https://api.stripe.com --port 8080
# API_BASE_URL=http://localhost:8080 npm test
```

Every exchange lands as a readable cassette:

```
recorded GET /posts/1 -> 200  (mocks/cassettes/0001-get-posts-1.json)
recorded GET /posts?_limit=1 -> 200  (mocks/cassettes/0002-get-posts-limit-1.json)
recorded POST /posts -> 201  (mocks/cassettes/0003-post-posts.json)
```

Then run the suite against the recordings. No network involved:

```sh
mock-anything verify -- npm test
```

```
mock-anything verify: serving 3 recorded interactions on http://localhost:8080
cassettes used: 3/3
PASS: the suite ran entirely against recorded responses
```

`verify` injects `MOCK_ANYTHING_URL` (plus `API_BASE_URL`/`BASE_URL`) so most apps need no code change at all: one environment variable swaps the base URL.

`list` shows what you recorded; `--json` makes it scriptable — a JSON array with `method`, `path`, `status`, `file` and `recordedAt` per cassette, and nothing else on stdout:
```sh
$ mock-anything list --json
[
  {
    "method": "GET",
    "path": "/posts/1",
    "status": 200,
    "file": "0001-get-posts-1.json",
    "recordedAt": "2026-11-22T06:30:07.085Z"
  }
]
```
Already have a capture? Import it instead of re-recording — record in the browser, replay in CI:
```sh
mock-anything import capture.har          # writes mocks/cassettes/0001-*.json ...
mock-anything verify -- npm test          # works unchanged on the imported cassettes
```
`import` decodes bodies (including base64 and gzip/deflate/brotli transfer encodings), applies the same credential redaction as recording, and keeps the capture order for repeated identical requests.

## Commands

| command | what it does |
|---|---|
| `record --target <url>` | forwarding proxy that records every request and response to `mocks/cassettes/`; repeat `--target name=<url> --prefix name=/path` to front several upstreams from one recorder |
| `serve` | answers from cassettes only; unmatched requests get a loud 502, never a silent fallthrough |
| `verify -- <cmd>` | starts `serve`, runs your test command against it, reports which cassettes were (and weren't) used |
| `check --target <url>` | replays every recorded request against the live API and reports drift, field by field |
| `list [--json]` | prints the recorded interactions as a table, or as a JSON array with `--json` |
| `import <file.har>` | converts a HAR 1.2 capture (browser devtools, Proxyman, Charles, mitmproxy) into cassettes |

If a command's port is busy you get an actionable message, e.g.
`port 8080 is already in use - pick another with --port`, for `record`, `serve` and `verify`.

Unknown `--flags` are rejected with an error naming them — a typo like `--targt`
fails fast with the usage instead of being silently ignored.

## Caught in the act

Mocks go stale silently. `check` is the alarm. Here a cassette's recorded title no longer matches what the API returns:

```
$ mock-anything check --target https://jsonplaceholder.typicode.com

mock-anything check: replaying 3 recorded requests against https://jsonplaceholder.typicode.com
DRIFT GET /posts/1:
  $.title: "a stale title from last month" -> "sunt aut facere repellat provident occaecati excepturi optio reprehenderit"
OK    GET /posts?_limit=1
OK    POST /posts

1/3 recordings have drifted - re-record to refresh your mocks
```

JSON responses get a structural diff down to the field. Exit code 1 on drift, so it drops straight into CI as a scheduled job.

## Real runs

From the demo in [`examples/posts-demo`](https://github.com/DhanushNehru/mock-anything/tree/main/examples/posts-demo): a three-test suite against a live public API, then the same suite fully replayed. Median of 5 runs on an ordinary cloud box, `node --test` only:

| suite run | live API | replayed |
|---|---|---|
| 3 tests, 3 HTTP calls | 269 ms | **123 ms** |

The demo API is fast and nearby, so the gap is modest. Against a real third-party API the difference is its entire latency, every single test run, plus the flakiness and rate limits you stop caring about. The point of the table is that nothing is invented: clone the repo and reproduce it with the commands above.

## How it works

- **Recording** is a forwarding proxy, not an SDK. Any language, any HTTP client: if your app can take a base URL, it can be recorded. Gzip, deflate and brotli responses are decoded before storage, so cassettes stay human-readable. One recorder can front several upstreams, routed by path prefix (see below).
- **Cassettes** are one JSON file per exchange in `mocks/cassettes/`, matched on method + full path + canonical request body (JSON key order doesn't matter). Repeated identical requests replay in recorded order.
- **Credentials never land in cassettes.** `authorization`, `cookie`, `x-api-key` and friends are stored as `<redacted>`; add your own with `MOCK_ANYTHING_REDACT="x-tenant-secret,x-session"`. Cassettes are meant to be committed, and this keeps them safe to commit.
- **Serving has no fallback.** The mock server contains no code path that talks to the recorded API. A request it doesn't recognize fails loudly with the list of things it does know, which is exactly what you want from a test double.

## Server-Sent Events

`text/event-stream` responses are recorded and replayed as streams, not buffered blobs. While recording, each event is forwarded to your app as it arrives; the cassette stores the ordered chunks plus the joined body, so the file stays readable JSON and `check` can still diff the content:

```json
"response": {
  "status": 200,
  "headers": { "content-type": "text/event-stream" },
  "body": "data: {\"n\":1}\n\ndata: {\"n\":2}\n\n",
  "bodyEncoding": "utf8",
  "stream": true,
  "chunks": [
    { "data": "data: {\"n\":1}\n\n", "encoding": "utf8", "delayMs": 0 },
    { "data": "data: {\"n\":2}\n\n", "encoding": "utf8", "delayMs": 40 }
  ]
}
```

On replay, `serve` writes the chunks one by one with the recorded pacing (each gap capped at 100 ms; set `MOCK_ANYTHING_STREAM_MAX_DELAY_MS=0` to replay instantly), so the client sees the same event framing instead of one buffered write. Normal buffered responses are untouched and still arrive with `content-length`.

A stream ends when the upstream closes it. If the upstream dies or the client disconnects mid-stream, the cassette is kept with `"truncated": true` and whatever chunks arrived. `check` replays a recorded stream against the live API and compares the joined text (chunk splitting is transport detail, not drift); a live stream that never closes is compared after `MOCK_ANYTHING_STREAM_TIMEOUT_MS` (default 30000 ms).
## Multiple upstreams in one recording

Real apps call several third-party APIs in one test run. Give each upstream a name and a local path prefix, plus at most one plain `--target <url>` as the default route for everything else:

```sh
mock-anything record --target api=https://api.stripe.com --prefix api=/stripe \
                     --target auth=https://auth.example.com --prefix auth=/auth \
                     --target https://api.myapp.dev \
                     --port 8080
```

The longest matching prefix wins, and the prefix is stripped before forwarding: `GET /stripe/v1/charges` goes to `https://api.stripe.com/v1/charges`, while `GET /api/user/7` goes to the default route untouched. A prefix matches its exact path and subpaths (`/stripe`, `/stripe/...`) but never a string-extension sibling (`/stripey`). A request no route matches gets a loud 502 listing the routes — never a silent fallthrough.

Each cassette records where it came from, so replay and drift-check route correctly with no extra flags:

```json
"upstream": { "name": "api", "target": "https://api.stripe.com", "prefix": "/stripe", "path": "/v1/charges" }
```

- `serve` matches on the full local path, so `/stripe/...` and `/auth/...` replay from their own cassettes. `list` shows each cassette's upstream.
- `check` sends every cassette to the upstream it was recorded from (using the stripped path) — `mock-anything check --dir ./mocks` works with no `--target` at all. `--target` is still required for cassettes recorded the old single-target way, which carry no `upstream` field.
- Existing single-target usage is unchanged: `record --target <url>` behaves exactly as before and its cassettes have no `upstream` field.



## What it doesn't do yet

- HTTP only. WebSockets and GraphQL subscriptions aren't recorded.
- Matching is exact on path and body; there's no fuzzy or partial matching, and no scripted responses.
- Request bodies with non-JSON content types match byte-for-byte.

These are deliberate scope lines for a first release, and good first contributions. See [CONTRIBUTING.md](https://github.com/DhanushNehru/mock-anything/blob/main/CONTRIBUTING.md).

## Docs

- [docs/quickstarts.md](docs/quickstarts.md) — copy-paste recipes for Express, Next.js and Python `requests`: point the base URL at an env var, record once, then `verify` offline.
- [docs/cassette-format.md](docs/cassette-format.md) — the cassette JSON schema field by field (request/response, headers, body, `bodyEncoding`, `recordedAt`, `<redacted>`, matching rules), so you can hand-write or generate cassettes.

## License

[MIT](https://github.com/DhanushNehru/mock-anything/blob/main/LICENSE)
