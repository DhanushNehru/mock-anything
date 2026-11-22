'use strict';

const { startRecorder } = require('./recorder');
const { startMockServer } = require('./server');
const { runVerify } = require('./verify');
const { runCheck } = require('./check');
const { loadCassettes } = require('./cassettes');
const { importHarFile } = require('./har');
const { buildRoutes } = require('./routes');

const VERSION = require('../package.json').version;

const USAGE = `mock-anything - record real API traffic, replay it offline, prove your tests still pass.

Usage:
  mock-anything record --target <url> [--port 8080] [--dir ./mocks]
  mock-anything record --target api=<url> --prefix api=/stripe \
                       --target auth=<url> --prefix auth=/auth   (multiple upstreams)
  mock-anything serve [--port 8080] [--dir ./mocks]
  mock-anything verify [--port 8080] [--dir ./mocks] -- <test command>
  mock-anything check [--target <url>] [--dir ./mocks]
  mock-anything list [--dir ./mocks] [--json]
  mock-anything import <file.har> [--dir ./mocks]
  mock-anything --version                     print the version and exit
  mock-anything <command> --help              command-specific flags and an example

Commands:
  record   forward proxy: records every request/response to cassettes
           (repeat --target name=<url> with --prefix name=/path to front
            several upstreams from one recorder; a plain --target <url>
            stays the default route for everything else)
  serve    answers from cassettes only; never touches the network
  verify   starts serve, runs your test command against it, reports cassette coverage
  check    replays recordings against the live API and reports drift
           (each cassette goes to the upstream it was recorded from;
            --target is only needed for old single-target cassettes)
  list     prints the recorded interactions (--json emits a JSON array for scripting)
  import   converts a HAR 1.2 capture (browser/Proxyman/Charles/mitmproxy) into cassettes

Environment:
  MOCK_ANYTHING_URL       set by verify; point your app's base URL at it
  MOCK_ANYTHING_REDACT    extra comma-separated header names to strip while recording
`;

const COMMANDS = new Set(['record', 'serve', 'verify', 'check', 'list', 'import']);

// Per-command help: short usage block with the flags that command actually
// accepts plus a copy-pasteable example. `mock-anything <command> --help`.
const COMMAND_HELP = {
  record: `mock-anything record - forward proxy: records every request/response to cassettes.

Usage:
  mock-anything record --target <url> [--port 8080] [--dir ./mocks]
  mock-anything record --target api=<url> --prefix api=/stripe \
                       --target auth=<url> --prefix auth=/auth   (multiple upstreams)

Flags:
  --target <url>    upstream to record; repeat as name=<url> to front several
                    upstreams, a plain --target stays the default route
  --prefix <path>   path prefix for a named target, e.g. --prefix api=/stripe
  --port <n>        local port to listen on (default 8080)
  --dir <path>      cassette root directory (default ./mocks)

Example:
  mock-anything record --target https://api.example.com --port 8080 --dir ./mocks
`,
  serve: `mock-anything serve - answers from cassettes only; never touches the network.

Usage:
  mock-anything serve [--port 8080] [--dir ./mocks]

Flags:
  --port <n>    port to serve on (default 8080)
  --dir <path>  cassette root directory (default ./mocks)

Example:
  mock-anything serve --port 8080 --dir ./mocks
`,
  verify: `mock-anything verify - starts serve, runs your test command against it, reports cassette coverage.

Usage:
  mock-anything verify [--port 8080] [--dir ./mocks] -- <test command>

Flags:
  --port <n>    port for the mock server (default 8080)
  --dir <path>  cassette root directory (default ./mocks)
  -- <command>  the test command to run; MOCK_ANYTHING_URL points at the mock

Example:
  mock-anything verify --port 8080 --dir ./mocks -- npm test
`,
  check: `mock-anything check - replays recordings against the live API and reports drift.

Usage:
  mock-anything check [--target <url>] [--dir ./mocks]

Flags:
  --target <url>  upstream for old single-target cassettes; cassettes recorded
                  with named targets go to the upstream they came from
  --dir <path>    cassette root directory (default ./mocks)

Example:
  mock-anything check --target https://api.example.com --dir ./mocks
`,
  list: `mock-anything list - prints the recorded interactions.

Usage:
  mock-anything list [--dir ./mocks] [--json]

Flags:
  --dir <path>  cassette root directory (default ./mocks)
  --json        emit a JSON array on stdout for scripting (e.g. | jq)

Example:
  mock-anything list --dir ./mocks --json
`,
  import: `mock-anything import - converts a HAR 1.2 capture (browser/Proxyman/Charles/mitmproxy) into cassettes.

Usage:
  mock-anything import <file.har> [--dir ./mocks]

Flags:
  <file.har>    HAR file to convert (positional)
  --dir <path>  cassette root directory (default ./mocks)

Example:
  mock-anything import capture.har --dir ./mocks
`,
};

// Flags parseFlags understands. When adding a flag, add it here and to USAGE;
// anything else starting with "--" is rejected instead of silently dropped,
// so a typo like --targt fails fast instead of causing a confusing later error.
const KNOWN_FLAGS = new Set(['--target', '--port', '--dir', '--json', '--prefix']);

function parseFlags(args) {
  const flags = { port: 8080, dir: './mocks', json: false, targets: [], prefixes: [] };
  const rest = [];
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target') {
      flags.target = args[++i]; // last one wins for the legacy single-target field
      flags.targets.push(flags.target);
    } else if (a === '--prefix') flags.prefixes.push(args[++i]);
    else if (a === '--port') flags.port = parseInt(args[++i], 10);
    else if (a === '--dir') flags.dir = args[++i];
    else if (a === '--json') flags.json = true;
    else if (a.startsWith('--') && a !== '--' && !KNOWN_FLAGS.has(a)) unknown.push(a);
    else rest.push(a);
  }
  return { flags, rest, unknown };
}

function assertKnownFlags(unknown) {
  if (unknown.length > 0) {
    throw new Error(`unknown flag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n\n${USAGE}`);
  }
}

async function main(argv) {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(VERSION + '\n');
    return;
  }

  // `mock-anything <command> --help` prints that command's own usage block.
  // For verify, only args before the "--" separator count, so a test command
  // like `verify -- npm test --help` is never mistaken for a help request.
  if (COMMANDS.has(command)) {
    const sep = command === 'verify' ? argv.indexOf('--') : -1;
    const end = sep === -1 ? argv.length : sep;
    const beforeSep = argv.slice(1, end);
    if (beforeSep.includes('--help') || beforeSep.includes('-h')) {
      process.stdout.write(COMMAND_HELP[command]);
      return;
    }
  }

  if (command === 'verify') {
    const sep = argv.indexOf('--');
    if (sep === -1 || sep === argv.length - 1) {
      throw new Error('verify needs a test command after "--", e.g. mock-anything verify -- npm test');
    }
    const { flags, unknown } = parseFlags(argv.slice(1, sep));
    assertKnownFlags(unknown);
    await runVerify({ port: flags.port, dir: flags.dir, command: argv.slice(sep + 1) });
    return;
  }

  const { flags, rest, unknown } = parseFlags(argv.slice(1));
  assertKnownFlags(unknown);

  switch (command) {
    case 'record':
      if (!flags.target) throw new Error('record needs --target <url>');
      await startRecorder({
        routes: buildRoutes({ targets: flags.targets, prefixes: flags.prefixes }),
        port: flags.port,
        dir: flags.dir,
      });
      break;
    case 'serve': {
      const mock = await startMockServer({ port: flags.port, dir: flags.dir });
      console.log(`mock-anything serve: ${mock.stats().total} recorded interactions on http://localhost:${flags.port}`);
      break;
    }
    case 'check':
      await runCheck({ target: flags.target, dir: flags.dir });
      break;
    case 'list': {
      const cassettes = loadCassettes(flags.dir);
      if (flags.json) {
        // Machine-readable output for scripting: a JSON array and nothing
        // else on stdout, so `mock-anything list --json | jq` works.
        const rows = cassettes.map((c) => ({
          method: c.request.method,
          path: c.request.path,
          status: c.response.status,
          file: c.file,
          recordedAt: c.recordedAt,
        }));
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        return;
      }
      if (cassettes.length === 0) {
        console.log(`no cassettes found in ${flags.dir}/cassettes`);
        return;
      }
      for (const c of cassettes) {
        const stream = c.response.stream ? `  [stream, ${c.response.chunks.length} chunks]` : '';
        const up = c.upstream ? `  [${c.upstream.name || 'default'} -> ${c.upstream.target}]` : '';
        console.log(`${c.request.method.padEnd(6)} ${c.request.path.padEnd(40)} -> ${c.response.status}${stream}${up}  (${c.file})`);
      }
      console.log(`${cassettes.length} recorded interactions`);
      break;
    }
    case 'import': {
      const harFile = rest[0];
      if (!harFile) throw new Error('import needs a HAR file, e.g. mock-anything import capture.har');
      const written = importHarFile(harFile, flags.dir);
      for (const w of written) {
        console.log(`imported ${w.cassette.request.method} ${w.cassette.request.path} -> ${w.cassette.response.status}  (${w.file})`);
      }
      console.log(`imported ${written.length} entries from ${harFile} into ${flags.dir}/cassettes`);
      break;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

module.exports = { main, parseFlags, COMMAND_HELP, VERSION };
