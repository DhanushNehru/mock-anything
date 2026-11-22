# Contributing to mock-anything

Thanks for helping make offline-first testing easier.

## Ground rules

- **One change per pull request.** Small PRs get reviewed; sweeping ones don't.
- **Tests must pass.** Run `npm test` before opening the PR. Add tests for behavior you change or add.
- **Zero runtime dependencies is a feature.** Please don't add one without opening an issue to discuss it first.
- **No network in tests.** The test suite spins up its own throwaway API server on localhost; keep it that way so CI stays hermetic.

## Good first contributions

- Partial or pattern-based request matching (e.g. match a body subset)
- A config file (`mock-anything.json`) for redaction lists and matching rules
- XML/HTML body diffing in `check`
- Cassette format docs and a JSON schema

Check the open issues for `good first issue` labels, or open an issue with your idea before writing code so we can agree on direction.

## Development

```sh
git clone https://github.com/DhanushNehru/mock-anything.git
cd mock-anything
npm test
```

CI runs `npm test` on Node 18, 20 and 22 on both ubuntu-latest and
windows-latest, so keep the code and the test script compatible with Node 18
and Windows (no shell globs in npm scripts: cmd.exe does not expand them).

The CLI is plain Node.js (18+) in `bin/` and `src/`. No build step.
