#!/usr/bin/env node
/**
 * Fail-closed gate for src/index.ts.
 *
 * Uses the published surfacepin 1.4 CLI:
 *   surfacepin lock   --stdio --surface tools -o surfacepin.lock.json -- <server>
 *   surfacepin verify --stdio --surface tools surfacepin.lock.json -- <server>
 *
 * pinStdio / verifyStdio are the same gate and are not required (they are not
 * in the 1.4.0 npm package). Pass/fail is exact-hash digest equality.
 * HINT_FLIP is a field-diff label, not a safety verdict.
 *
 * Verify (default) exits non-zero on digest drift or a missing lockfile.
 * It does not write a lockfile. `node check.mjs --lock` writes one; commit it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lockPath = join(here, 'surfacepin.lock.json');
const lockMode = process.argv.includes('--lock');

function findTsx() {
  const candidates = [
    join(here, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function serverArgv() {
  if (process.env.SURFACEPIN_SERVER) {
    const extra = process.env.SURFACEPIN_SERVER_ARGS
      ? process.env.SURFACEPIN_SERVER_ARGS.split(/\s+/).filter(Boolean)
      : [];
    return [process.env.SURFACEPIN_SERVER, ...extra];
  }

  const tsx = findTsx();
  if (tsx) return [process.execPath, tsx, join(here, 'src', 'index.ts')];

  const built = join(here, 'build', 'index.js');
  if (existsSync(built)) return [process.execPath, built];

  console.error('Cannot run the server. Install tsx (`pnpm install` in this repo) or build to build/index.js.');
  process.exit(2);
}

function surfacepinInvocation() {
  if (process.env.SURFACEPIN_BIN) {
    if (!existsSync(process.env.SURFACEPIN_BIN)) {
      console.error(`SURFACEPIN_BIN does not exist: ${process.env.SURFACEPIN_BIN}`);
      process.exit(2);
    }
    return { command: process.execPath, args: [process.env.SURFACEPIN_BIN] };
  }

  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('surfacepin/package.json');
    const cli = join(dirname(pkgJson), 'dist', 'cli.js');
    if (existsSync(cli)) return { command: process.execPath, args: [cli] };
  } catch {
    // Not installed next to this example.
  }

  console.error('surfacepin is not installed locally; using npx surfacepin@1.4.0');
  return { command: 'npx', args: ['--yes', '--package', 'surfacepin@1.4.0', 'surfacepin'] };
}

if (!lockMode && !existsSync(lockPath)) {
  console.error(`missing ${lockPath}`);
  console.error('Fail closed. Lock the live server, then commit that file:');
  console.error('  node check.mjs --lock');
  process.exit(1);
}

const server = serverArgv();
const surfacepin = surfacepinInvocation();
const commandArgs = lockMode
  ? [...surfacepin.args, 'lock', '--stdio', '--surface', 'tools', '-o', lockPath, '--', ...server]
  : [...surfacepin.args, 'verify', '--stdio', '--surface', 'tools', lockPath, '--', ...server];

const result = spawnSync(surfacepin.command, commandArgs, {
  cwd: here,
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}

process.exit(result.status ?? 2);
