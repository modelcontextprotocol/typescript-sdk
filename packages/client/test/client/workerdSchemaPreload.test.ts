/**
 * Platform-conditional schema warm-up pins, asserted against the real build
 * outputs.
 *
 * The wire schemas are built lazily by default — the right trade on
 * process-per-invocation runtimes, where module evaluation is boot latency.
 * On isolate platforms (workerd), module scope evaluates during isolate
 * warm-up outside any request's billed CPU, so the workerd shim calls
 * `preloadSchemas()` at module scope to keep construction out of the first
 * request. Two regressions would be silent without these pins:
 *
 * 1. The workerd condition loses its module-scope call (a shim refactor drops
 *    it) — fresh isolates go back to paying schema construction inside the
 *    first request's CPU.
 * 2. The node or browser condition gains one (an import shuffle re-eagerizes
 *    it) — every process boot / page load pays construction for validations
 *    that may never happen.
 *
 * Identity also matters: the warm-up only helps if the shim forces the SAME
 * memo module the package entry validates through. The shim entry must
 * import `preloadSchemas` from the shared chunk — a duplicated definition in
 * the shim chunk would warm a twin module and leave the real one cold.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

import { ensureBuilt } from '../helpers/ensureBuilt';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = join(pkgDir, 'dist');

/**
 * A module-scope `preloadSchemas();` call: statement at column 0 — entry-level
 * statements are unindented in the unminified build output, while statements
 * inside function bodies are indented, so a call that merely sits in some
 * bundled helper body cannot satisfy (or trip) this pin. The CJS build calls
 * through the required chunk's namespace (`require_src.preloadSchemas();`),
 * so an optional receiver is allowed.
 */
const MODULE_SCOPE_PRELOAD_CALL = /^(?:[\w$]+\.)?preloadSchemas\(\);/m;

/**
 * An entry-level `import { …, X as preloadSchemas, … } from "./chunk"` (or
 * the un-aliased `{ preloadSchemas }` form), capturing the chunk specifier.
 */
const PRELOAD_IMPORT = /import\s*\{[^}]*\bpreloadSchemas\b[^}]*\}\s*from\s*"(\.\/[^"]+)"/;

function dist(file: string): string {
    return readFileSync(join(distDir, file), 'utf8');
}

describe('workerd schema warm-up (built dist)', () => {
    beforeAll(async () => {
        await ensureBuilt(pkgDir);
    }, 180_000);

    test('shimsWorkerd calls preloadSchemas() at module scope (ESM and CJS)', () => {
        expect(dist('shimsWorkerd.mjs')).toMatch(MODULE_SCOPE_PRELOAD_CALL);
        expect(dist('shimsWorkerd.cjs')).toMatch(MODULE_SCOPE_PRELOAD_CALL);
    });

    test('node and browser shims stay lazy — no preloadSchemas reference at all', () => {
        for (const shim of ['shimsNode.mjs', 'shimsNode.cjs', 'shimsBrowser.mjs', 'shimsBrowser.cjs']) {
            expect(dist(shim), `${shim} must not re-eagerize schema construction`).not.toMatch(/\bpreloadSchemas\b/);
        }
    });

    test('the root entry exports preloadSchemas but never calls it at module scope', () => {
        const index = dist('index.mjs');
        expect(index).toMatch(/\bpreloadSchemas\b/);
        expect(index).not.toMatch(MODULE_SCOPE_PRELOAD_CALL);
    });

    test('the workerd shim warms the same chunk the root entry uses (no duplicated schema graph)', () => {
        const entries = ['index.mjs', 'shimsWorkerd.mjs', 'shimsNode.mjs', 'shimsBrowser.mjs', 'stdio.mjs'];
        for (const entry of entries) {
            expect(dist(entry), `${entry} must not carry its own preloadSchemas definition`).not.toMatch(/function preloadSchemas\b/);
        }

        const shimSource = dist('shimsWorkerd.mjs').match(PRELOAD_IMPORT)?.[1];
        const indexSource = dist('index.mjs').match(PRELOAD_IMPORT)?.[1];
        expect(shimSource).toBeDefined();
        expect(indexSource).toBeDefined();
        expect(shimSource).toBe(indexSource);
        expect(dist(shimSource!.replace('./', ''))).toMatch(/function preloadSchemas\b/);
    });
});
