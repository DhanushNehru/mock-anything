# Framework quickstarts

The recorder is a forwarding proxy, not an SDK: any language and any HTTP
client can be recorded, as long as your app takes its base URL from an
environment variable. `mock-anything verify` starts the mock server and sets
`MOCK_ANYTHING_URL` (plus `API_BASE_URL` and `BASE_URL`) for your test command,
so most apps need no code change beyond reading one of those variables.

Every `mock-anything` command below was run against a local throwaway API
while writing this page.

## Express (Node.js)

```js
// app.js
const baseUrl = process.env.MOCK_ANYTHING_URL || process.env.API_BASE_URL || 'https://api.example.com';
// fetch(`${baseUrl}/posts/1`) wherever the app calls the API
```

```sh
# 1. record the real API once
mock-anything record --target https://api.example.com --port 8080
#    in another shell, run the suite against the recorder:
API_BASE_URL=http://localhost:8080 npm test

# 2. later, prove the suite passes offline
mock-anything verify -- npm test
```

## Next.js

Server-side code (API routes, `getServerSideProps`) can read the env directly:

```js
// lib/api.js
export const baseUrl =
  process.env.MOCK_ANYTHING_URL || process.env.API_BASE_URL || 'https://api.example.com';
```

In browser bundles use `NEXT_PUBLIC_API_URL`; set it to the mock when you run
the app against recordings:

```sh
mock-anything serve --port 8080            # serves cassettes only
NEXT_PUBLIC_API_URL=http://localhost:8080 npm run dev
```

and in Node-based tests (`npm test`, Jest/Vitest) the injected
`MOCK_ANYTHING_URL` is visible directly:

```sh
mock-anything record --target https://api.example.com --port 8080
mock-anything verify -- npm test           # sets MOCK_ANYTHING_URL for the test run
```

## Python (requests)

```python
# config.py
import os
BASE_URL = os.environ.get("MOCK_ANYTHING_URL", "https://api.example.com")
```

```python
# test_api.py
import requests
from config import BASE_URL

def test_get_post():
    r = requests.get(f"{BASE_URL}/posts/1", timeout=5)
    assert r.status_code == 200
    assert r.json()["id"] == 1
```

```sh
mock-anything record --target https://api.example.com --port 8080
mock-anything verify -- python3 -m pytest
```

## Inspecting what was recorded

```sh
mock-anything list --dir ./mocks          # human-readable table
mock-anything list --dir ./mocks --json   # JSON array for scripting (| jq)
```

The on-disk layout of what `list` shows is documented field by field in
[cassette-format.md](cassette-format.md).
