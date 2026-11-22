'use strict';

/**
 * Listen errors are rethrown with an actionable message where they happen:
 * bin/mock-anything.js prints err.message cleanly, so a busy port should say
 * so instead of surfacing a raw EADDRINUSE stack. Every other error passes
 * through untouched. Lives in its own module so both recorder.js and
 * server.js can use it without a circular require.
 */
function friendlyListenError(err, port) {
  if (err && err.code === 'EADDRINUSE') {
    return new Error(`port ${port} is already in use - pick another with --port`);
  }
  return err;
}

module.exports = { friendlyListenError };
