#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Navigate from dist/esm/bin/ to dist/esm/examples/
const backfillScript = join(__dirname, '../examples/backfill/backfillSampling.js');
const serverScript = join(__dirname, '../examples/server/toolLoopSampling.js');

// Run the backfill proxy with the tool loop server
const child = spawn('node', [backfillScript, 'node', serverScript], {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
