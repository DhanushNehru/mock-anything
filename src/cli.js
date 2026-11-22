'use strict';

const { startRecorder } = require('./recorder');
const { startMockServer } = require('./server');
const { runVerify } = require('./verify');
const { runCheck } = require('./check');
const { loadCassettes } = require('./cassettes');

const USAGE = `mock-anything - record real API traffic, replay it offline, prove your tests still pass.

Usage:
  mock-anything record --target <url> [--port 8080] [--dir ./mocks]
  mock-anything serve [--port 8080] [--dir ./mocks]
  mock-anything verify [--port 8080] [--dir ./mocks] -- <test command>
  mock-anything check --target <url> [--dir ./mocks]
  mock-anything list [--dir ./mocks]

Commands:
  record   forward proxy: records every request/response to cassettes
  serve    answers from cassettes only; never touches the network
  verify   starts serve, runs your test command against it, reports cassette coverage
  check    replays recordings against the live API and reports drift
  list     prints the recorded interactions

Environment:
  MOCK_ANYTHING_URL       set by verify; point your app's base URL at it
  MOCK_ANYTHING_REDACT    extra comma-separated header names to strip while recording

Unknown --flags are rejected with an error naming them, not silently ignored.
`;

// Flags parseFlags understands. When adding a flag, add it here and to USAGE;
// anything else starting with "--" is rejected instead of silently dropped,
// so a typo like --targt fails fast instead of causing a confusing later error.
const KNOWN_FLAGS = new Set(['--target', '--port', '--dir']);

function parseFlags(args) {
  const flags = { port: 8080, dir: './mocks' };
  const rest = [];
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target') flags.target = args[++i];
    else if (a === '--port') flags.port = parseInt(args[++i], 10);
    else if (a === '--dir') flags.dir = args[++i];
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

  const { flags, unknown } = parseFlags(argv.slice(1));
  assertKnownFlags(unknown);

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
      if (cassettes.length === 0) {
        console.log(`no cassettes found in ${flags.dir}/cassettes`);
        return;
      }
      for (const c of cassettes) {
        console.log(`${c.request.method.padEnd(6)} ${c.request.path.padEnd(40)} -> ${c.response.status}  (${c.file})`);
      }
      console.log(`${cassettes.length} recorded interactions`);
      break;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

module.exports = { main, parseFlags };
