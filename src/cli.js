'use strict';

const { startRecorder } = require('./recorder');
const { startMockServer } = require('./server');
const { runVerify } = require('./verify');
const { runCheck } = require('./check');
const { loadCassettes } = require('./cassettes');
const { importHarFile } = require('./har');

const USAGE = `mock-anything - record real API traffic, replay it offline, prove your tests still pass.

Usage:
  mock-anything record --target <url> [--port 8080] [--dir ./mocks]
  mock-anything serve [--port 8080] [--dir ./mocks]
  mock-anything verify [--port 8080] [--dir ./mocks] -- <test command>
  mock-anything check --target <url> [--dir ./mocks]
  mock-anything list [--dir ./mocks] [--json]
  mock-anything list [--dir ./mocks]
  mock-anything import <file.har> [--dir ./mocks]

Commands:
  record   forward proxy: records every request/response to cassettes
  serve    answers from cassettes only; never touches the network
  verify   starts serve, runs your test command against it, reports cassette coverage
  check    replays recordings against the live API and reports drift
  list     prints the recorded interactions (--json emits a JSON array for scripting)
  import   converts a HAR 1.2 capture (browser/Proxyman/Charles/mitmproxy) into cassettes

Environment:
  MOCK_ANYTHING_URL       set by verify; point your app's base URL at it
  MOCK_ANYTHING_REDACT    extra comma-separated header names to strip while recording
`;

function parseFlags(args) {
  const flags = { port: 8080, dir: './mocks', json: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target') flags.target = args[++i];
    else if (a === '--port') flags.port = parseInt(args[++i], 10);
    else if (a === '--dir') flags.dir = args[++i];
    else if (a === '--json') flags.json = true;
    else rest.push(a);
  }
  return { flags, rest };
}

async function main(argv) {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'verify') {
    const sep = argv.indexOf('--');
    if (sep === -1 || sep === argv.length - 1) {
      throw new Error('verify needs a test command after "--", e.g. mock-anything verify -- npm test');
    }
    const { flags } = parseFlags(argv.slice(1, sep));
    await runVerify({ port: flags.port, dir: flags.dir, command: argv.slice(sep + 1) });
    return;
  }

  const { flags, rest } = parseFlags(argv.slice(1));

  switch (command) {
    case 'record':
      if (!flags.target) throw new Error('record needs --target <url>');
      await startRecorder({ target: flags.target, port: flags.port, dir: flags.dir });
      break;
    case 'serve': {
      const mock = await startMockServer({ port: flags.port, dir: flags.dir });
      console.log(`mock-anything serve: ${mock.stats().total} recorded interactions on http://localhost:${flags.port}`);
      break;
    }
    case 'check':
      if (!flags.target) throw new Error('check needs --target <url>');
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
        console.log(`${c.request.method.padEnd(6)} ${c.request.path.padEnd(40)} -> ${c.response.status}${stream}  (${c.file})`);
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

module.exports = { main };
