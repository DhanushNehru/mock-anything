'use strict';

const { spawn } = require('child_process');
const { startMockServer } = require('./server');

function waitForServer(port, tries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = require('http').get({ host: '127.0.0.1', port, path: '/__mock_anything_ping' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (left <= 0) return reject(new Error('mock server did not start'));
        setTimeout(() => attempt(left - 1), 100);
      });
    };
    attempt(tries);
  });
}

// On Windows the npm/npx bins are .cmd shims that CreateProcess cannot launch
// directly, so the test command must go through the platform shell there.
// Everywhere else keep shell:false so arguments are passed verbatim without
// quoting surprises.
function spawnShellFor(platform) {
  return platform === 'win32';
}

async function runVerify({ port, dir, command }) {
  const mock = await startMockServer({ port, dir });
  await waitForServer(port);
  const url = `http://localhost:${port}`;
  console.log(`mock-anything verify: serving ${mock.stats().total} recorded interactions on ${url}`);
  console.log(`running: ${command.join(' ')}`);

  const env = {
    ...process.env,
    MOCK_ANYTHING_URL: url,
    // Common base-URL variables; harmless when unused.
    API_BASE_URL: url,
    BASE_URL: url,
  };

  const code = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: 'inherit', shell: spawnShellFor(process.platform) });
    child.on('close', resolve);
  });

  const stats = mock.stats();
  console.log('');
  console.log(`cassettes used: ${stats.hit}/${stats.total}`);
  for (const f of stats.unused) console.log(`  never requested: ${f}`);
  mock.server.close();

  if (code === 0) {
    console.log('PASS: the suite ran entirely against recorded responses');
  } else {
    console.log(`FAIL: the command exited with code ${code}`);
  }
  process.exitCode = code;
  return code;
}

module.exports = { runVerify, spawnShellFor };
