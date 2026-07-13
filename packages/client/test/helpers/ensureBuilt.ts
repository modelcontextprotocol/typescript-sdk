import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Canonical dist sentinels per package. Every caller waits on the same
 * complete set: if callers checked their own subsets, a partial dist (from an
 * interrupted build) could satisfy one caller's fast path while another still
 * rebuilds — and the rebuild's clean step would wipe files under the first
 * caller's running tests, which is exactly the race this helper exists to
 * prevent.
 */
const DIST_SENTINELS: Record<string, string[]> = {
    // Include late-written artifacts (dts pass, CJS validators) so an
    // interrupted build never satisfies the fast path.
    client: ['index.mjs', 'stdio.mjs', 'validators/ajv.cjs', 'index.d.mts', 'index.d.cts'],
    core: ['index.mjs', 'internal.mjs', 'index.d.mts', 'internal.d.mts']
};

/** The build is killed after this long; execFile's kill still runs our finally. */
const BUILD_TIMEOUT_MS = 60_000;
/** How long a waiter polls for another worker's build — outlasts BUILD_TIMEOUT_MS. */
const WAIT_DEADLINE_MS = 90_000;
/** A lock older than this belongs to a dead worker (finally never ran) — steal it. */
const STALE_LOCK_MS = 120_000;

/**
 * Build a package's dist on demand, safely across parallel vitest workers.
 *
 * Vitest runs test files in separate worker processes, so two files that each
 * "build if dist is missing" can race on a cold checkout: both see no dist,
 * both spawn `pnpm build`, and tsdown's clean step deletes files out from
 * under whichever worker is already reading them. This helper makes the build
 * single-flight with an atomic mkdir lock: the first worker builds, everyone
 * else waits for the sentinel files to appear and the lock to clear, and once
 * the dist exists nobody ever rebuilds (so no later clean can wipe it
 * mid-read).
 */
export async function ensureBuilt(pkgDir: string): Promise<void> {
    const sentinels = DIST_SENTINELS[basename(pkgDir)];
    if (!sentinels) {
        throw new Error(`No dist sentinels registered for ${pkgDir} — add the package to DIST_SENTINELS`);
    }
    const lockDir = join(pkgDir, '.dist-build-lock');
    const haveAll = () => sentinels.every(s => existsSync(join(pkgDir, 'dist', s)));
    const deadline = Date.now() + WAIT_DEADLINE_MS;
    for (;;) {
        if (haveAll() && !existsSync(lockDir)) return;
        try {
            mkdirSync(lockDir);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            // Another worker holds the lock. If the holder died without its
            // finally running (SIGKILL/OOM), the lock never clears — steal it
            // once it is older than any live build could be.
            try {
                if (Date.now() - statSync(lockDir).mtimeMs > STALE_LOCK_MS) {
                    // renameSync is atomic: exactly one waiter steals; losers throw and re-check.
                    const graveyard = `${lockDir}.stale-${process.pid}-${Date.now()}`;
                    renameSync(lockDir, graveyard);
                    rmSync(graveyard, { recursive: true, force: true });
                    continue;
                }
            } catch {
                continue; // lock vanished or another waiter stole it — re-check now
            }
            if (Date.now() > deadline) {
                throw new Error(
                    `Timed out waiting for ${pkgDir}/dist (${sentinels.join(', ')}) ` +
                        `while another worker held the build lock at ${lockDir}`
                );
            }
            await sleep(250);
            continue;
        }
        try {
            if (!haveAll()) {
                try {
                    await execFileAsync('pnpm', ['build'], {
                        cwd: pkgDir,
                        timeout: BUILD_TIMEOUT_MS,
                        maxBuffer: 16 * 1024 * 1024
                    });
                } catch (err) {
                    const stderr = (err as { stderr?: string }).stderr ?? '';
                    throw new Error(`pnpm build failed in ${pkgDir}: ${(err as Error).message}\n${stderr.slice(-2000)}`);
                }
            }
            return;
        } finally {
            rmSync(lockDir, { recursive: true, force: true });
        }
    }
}
