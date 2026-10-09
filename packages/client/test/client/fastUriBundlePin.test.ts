/**
 * Bundled fast-uri pin: the copy inlined into this package's dist is the one
 * the root `resolutions` field pins — 3.1.8, the first release without the
 * nine published advisories.
 *
 * `ajv`/`ajv-formats` are `noExternal` in tsdown.config.ts, so the transitive
 * `fast-uri` is bundled into `dist/` and never reaches the published manifest:
 * consumer overrides/resolutions and lockfile-based scanners can neither see
 * nor reach it. Which copy actually ships is observable only in the built
 * output, so pin it there. The version surfaces in two places — rolldown's
 * `#region` comments over the inlined modules, and the dts shim's provenance
 * comment (packages/core-internal/src/validators/fastUriShim.d.ts, mapped in
 * through `dts.compilerOptions.paths`) — and both must name the pinned
 * version. At least one marker must exist at all: the inlining is the fix, and
 * a config change that drops `ajv`/`ajv-formats` from `noExternal` would hand
 * the unresolved dependency back to consumers.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

import { ensureBuilt } from '../helpers/ensureBuilt';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = join(pkgDir, 'dist');
const repoRoot = join(pkgDir, '..', '..');

/** The exact version root package.json pins `fast-uri` to via `resolutions`. */
function pinnedFastUri(): string {
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        resolutions?: Record<string, string>;
    };
    const pinned = rootManifest.resolutions?.['fast-uri'];
    expect(pinned, 'root package.json no longer pins fast-uri via resolutions').toMatch(/^\d+\.\d+\.\d+$/);
    return pinned!;
}

describe('the bundled fast-uri copy is the pinned one', () => {
    beforeAll(async () => {
        await ensureBuilt(pkgDir);
    }, 240_000);

    test('every fast-uri marker in dist names the pinned version', () => {
        const pinned = pinnedFastUri();
        // The shipped artifacts: .mjs/.cjs runtime plus .d.mts/.d.cts types.
        // Sourcemaps (.map) only mirror those chunks' module paths, so they
        // carry no independent copy of the version.
        const artifacts = readdirSync(distDir, { recursive: true })
            .map(String)
            .filter(file => /\.(mjs|cjs|d\.mts|d\.cts)$/.test(file));

        const versions = new Set<string>();
        for (const artifact of artifacts) {
            const source = readFileSync(join(distDir, artifact), 'utf8');
            for (const marker of source.matchAll(/fast-uri@(\d+\.\d+\.\d+)/g)) {
                versions.add(marker[1]!);
            }
        }

        expect(
            [...versions],
            'dist/ carries no fast-uri version marker at all — ajv/ajv-formats must stay noExternal in tsdown.config.ts, ' +
                'which is what inlines fast-uri and its #region markers'
        ).toContain(pinned);
        expect(
            [...versions].filter(version => version !== pinned),
            `dist/ inlines a fast-uri version other than the pinned ${pinned} — check the resolutions pin, the lockfile resolution, ` +
                'and the dts shim provenance comment'
        ).toEqual([]);
    });
});
