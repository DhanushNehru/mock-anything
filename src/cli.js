'use strict';

const { startRecorder } = require('./recorder');
const { startMockServer } = require('./server');
const { runVerify } = require('./verify');
const { runCheck } = require('./check');
const { loadCassettes } = require('./cassettes');
const { buildRoutes } = require('./routes');

const USAGE = `mock-anything - record real API traffic, replay it offline, prove your tests still pass.

Usage:
  mock-anything record --target <url> [--port 8080] [--dir ./mocks]
  mock-anything record --target api=<url> --prefix api=/stripe \
                       --target auth=<url> --prefix auth=/auth   (multiple upstreams)
  mock-anything serve [--port 8080] [--dir ./mocks]
  mock-anything verify [--port 8080] [--dir ./mocks] -- <test command>
  mock-anything check [--target <url>] [--dir ./mocks]
  mock-anything list [--dir ./mocks]

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
  list     prints the recorded interactions

Environment:
  MOCK_ANYTHING_URL       set by verify; point your app's base URL at it
  MOCK_ANYTHING_REDACT    extra comma-separated header names to strip while recording
`;

function parseFlags(args) {
  const flags = { port: 8080, dir: './mocks', targets: [], prefixes: [] };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target') {
      flags.target = args[++i]; // last one wins for the legacy single-target field
      flags.targets.push(flags.target);
    } else if (a === '--prefix') flags.prefixes.push(args[++i]);
    else if (a === '--port') flags.port = parseInt(args[++i], 10);
    else if (a === '--dir') flags.dir = args[++i];
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

  const { flags } = parseFlags(argv.slice(1));

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
      if (cassettes.length === 0) {
        console.log(`no cassettes found in ${flags.dir}/cassettes`);
        return;
      }
      for (const c of cassettes) {
        const up = c.upstream ? `  [${c.upstream.name || 'default'} -> ${c.upstream.target}]` : '';
        console.log(`${c.request.method.padEnd(6)} ${c.request.path.padEnd(40)} -> ${c.response.status}${up}  (${c.file})`);
      }
      console.log(`${cassettes.length} recorded interactions`);
      break;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

module.exports = { main };
