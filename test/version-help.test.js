'use strict';

// `mock-anything --version` / `-v` prints the package.json version, and every
// command has its own `--help` / `-h` block with its flags and an example.
// Global `--help` still prints the global usage, now mentioning both.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { main, COMMAND_HELP } = require('../src/cli');
const { version } = require('../package.json');

const BIN = path.join(__dirname, '..', 'bin', 'mock-anything.js');
const COMMANDS = ['record', 'serve', 'verify', 'check', 'list', 'import', 'export'];

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

async function captureMain(argv) {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    await main(argv);
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

test('--version and -v print the package version and exit 0', async () => {
  for (const flag of ['--version', '-v']) {
    const out = await captureMain([flag]);
    assert.equal(out.trim(), version, `${flag} output`);
    const res = run([flag]);
    assert.equal(res.status, 0, `${flag} via bin`);
    assert.equal(res.stdout.trim(), version);
  }
});

test('every command has a --help block with usage, flags and an example', async () => {
  for (const command of COMMANDS) {
    assert.ok(COMMAND_HELP[command], `COMMAND_HELP is missing ${command}`);
    for (const helpFlag of ['--help', '-h']) {
      const out = await captureMain([command, helpFlag]);
      assert.match(out, /Usage:/, `${command} ${helpFlag} shows a Usage line`);
      assert.match(out, new RegExp(`mock-anything ${command}`), `${command} ${helpFlag} names the command`);
      assert.match(out, /Flags:/, `${command} ${helpFlag} lists flags`);
      assert.match(out, /Example:/, `${command} ${helpFlag} has an example`);
      const res = run([command, helpFlag]);
      assert.equal(res.status, 0, `${command} ${helpFlag} via bin exits 0`);
      assert.match(res.stdout, /Usage:/);
    }
  }
});

test('command help documents that command only, not the global command list', async () => {
  const recordHelp = await captureMain(['record', '--help']);
  assert.match(recordHelp, /--target/);
  assert.doesNotMatch(recordHelp, /mock-anything serve/);
  const verifyHelp = await captureMain(['verify', '--help']);
  assert.match(verifyHelp, /-- <test command>/);
  assert.match(verifyHelp, /--strict/);
  assert.match(verifyHelp, /--env-var/);
});

test('help wins over other flags for a command, but verify keeps its -- separator', async () => {
  const out = await captureMain(['list', '--json', '--help']);
  assert.match(out, /Usage:/);
  assert.doesNotMatch(out, /^\[/m); // did not run list --json
  const verifyOut = await captureMain(['verify', '--help', '--', 'echo', 'hi']);
  assert.match(verifyOut, /Usage:/);
  assert.match(verifyOut, /verify/);
});

test('global --help is unchanged apart from mentioning --version and per-command help', async () => {
  const out = await captureMain(['--help']);
  assert.match(out, /Usage:/);
  assert.match(out, /record --target/);
  assert.match(out, /--version/);
  assert.match(out, /<command> --help|command --help/);
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--version/);
});

test('unknown command still errors with the global usage', async () => {
  await assert.rejects(() => main(['frobnicate']), /unknown command "frobnicate"/);
  const res = run(['frobnicate']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown command/);
});

test('unknown flags still fail fast even alongside --help being absent', () => {
  const res = run(['serve', '--nope']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown flag: --nope/);
});
