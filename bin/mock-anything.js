#!/usr/bin/env node
'use strict';
const { main } = require('../src/cli');
main(process.argv.slice(2)).catch((err) => {
  console.error(`mock-anything: ${err.message}`);
  process.exit(1);
});
