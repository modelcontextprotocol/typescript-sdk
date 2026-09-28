#!/usr/bin/env node
/**
 * Fail-closed gate for src/index.ts.
 *
 * Uses surfacepin@^1.5.0: pinStdio / verifyStdio. Pass/fail is exact-hash
 * digest equality. HINT_FLIP is a field-diff label, not a safety verdict.
 *
 * Verify (default) exits non-zero on digest drift or a missing lockfile.
 * It does not write a lockfile. `node check.mjs --lock` writes one; commit it.
 *
 * The CLI is the same gate:
 *   surfacepin lock   --stdio --surface tools -o surfacepin.lock.json -- <server>
 *   surfacepin verify --stdio --surface tools surfacepin.lock.json -- <server>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lockPath = join(here, 'surfacepin.lock.json');
const lockMode = process.argv.includes('--lock');

let pinStdio;
let verifyStdio;
let formatDiff;
try {
  ({ pinStdio, verifyStdio, formatDiff } = await import('surfacepin'));
} catch (error) {
  console.error('Cannot load surfacepin. Install the example devDependency: surfacepin@^1.5.0');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

function serverSpawn() {
  if (process.env.SURFACEPIN_SERVER) {
    const extra = process.env.SURFACEPIN_SERVER_ARGS
      ? process.env.SURFACEPIN_SERVER_ARGS.split(/\s+/).filter(Boolean)
      : [];
    return { command: process.env.SURFACEPIN_SERVER, args: extra };
  }

  const tsxCandidates = [
    join(here, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const tsx of tsxCandidates) {
    if (existsSync(tsx)) {
      return { command: process.execPath, args: [tsx, join(here, 'src', 'index.ts')] };
    }
  }

  const built = join(here, 'build', 'index.js');
  if (existsSync(built)) return { command: process.execPath, args: [built] };

  console.error('Cannot run the server. Install tsx (`pnpm install` in this repo) or build to build/index.js.');
  process.exit(2);
}

if (!lockMode && !existsSync(lockPath)) {
  console.error(`missing ${lockPath}`);
  console.error('Fail closed. Lock the live server, then commit that file:');
  console.error('  node check.mjs --lock');
  process.exit(1);
}

const server = serverSpawn();
const spawn = {
  command: server.command,
  args: server.args,
  surfaces: ['tools'],
  timeoutMs: 20_000,
  cwd: here,
};

if (lockMode) {
  const pinned = await pinStdio(spawn);
  writeFileSync(lockPath, pinned.text, 'utf8');
  console.log(`wrote ${lockPath}`);
  console.log(`ROOT ${pinned.root}`);
  process.exit(0);
}

const lockfile = JSON.parse(readFileSync(lockPath, 'utf8'));
const checked = await verifyStdio({ ...spawn, lockfile });
console.log(formatDiff(checked.diff));
process.exit(checked.ok ? 0 : 1);
