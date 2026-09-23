/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/2701
 *
 * Subpath imports such as `@modelcontextprotocol/sdk/server/mcp.js` fell through
 * the `"./*"` export pattern, whose `types` target is `./dist/esm/*.d.ts`. The
 * wildcard captures the whole remainder including the extension, so the types
 * path resolved to `dist/esm/server/mcp.js.d.ts` — a file that does not exist
 * (the real one is `mcp.d.ts`).
 *
 * TypeScript happens to paper over this via the `typesVersions` fallback, so the
 * breakage is invisible to `tsc`. Resolvers that implement `exports` without
 * `typesVersions` — notably Deno — fail with TS2307, which then cascades into
 * implicit-any errors on every inferred callback parameter.
 *
 * A `"./*.js"` pattern fixes it: Node prefers the more specific pattern, so the
 * extension is excluded from the wildcard capture.
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');

type ConditionMap = Record<string, string>;

const exportsMap: Record<string, ConditionMap> = JSON.parse(readFileSync(resolvePath(repoRoot, 'package.json'), 'utf8')).exports;

/**
 * Minimal implementation of Node's subpath resolution: exact keys win, then the
 * pattern with the longest prefix before `*`.
 */
function resolveSubpath(subpath: string, condition: keyof ConditionMap): string | undefined {
    const exact = exportsMap[subpath];
    if (exact) {
        return exact[condition];
    }

    let best: { target: string; prefixLength: number } | undefined;
    for (const [pattern, conditions] of Object.entries(exportsMap)) {
        const starIndex = pattern.indexOf('*');
        if (starIndex === -1) {
            continue;
        }
        const prefix = pattern.slice(0, starIndex);
        const suffix = pattern.slice(starIndex + 1);
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
            continue;
        }
        if (best && prefix.length <= best.prefixLength) {
            continue;
        }
        const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
        best = { target: conditions[condition].replace('*', captured), prefixLength: prefix.length };
    }
    return best?.target;
}

describe('Issue #2701: .js subpath exports resolve to real declaration files', () => {
    // Representative of the import style used throughout the README and examples.
    const subpaths = ['./server/mcp.js', './server/stdio.js', './server/streamableHttp.js', './client/streamableHttp.js'];

    test.each(subpaths)('%s resolves types to a .d.ts, not a .js.d.ts', subpath => {
        const types = resolveSubpath(subpath, 'types');
        expect(types).toBeDefined();
        expect(types).not.toMatch(/\.js\.d\.ts$/);
        expect(types).toBe(`./dist/esm/${subpath.slice('./'.length).replace(/\.js$/, '')}.d.ts`);
    });

    test.each(subpaths)('%s maps to source that actually exists', subpath => {
        const sourceFile = resolvePath(repoRoot, 'src', subpath.slice('./'.length).replace(/\.js$/, '.ts'));
        expect(existsSync(sourceFile)).toBe(true);
    });

    test.each(subpaths)('%s keeps runtime targets intact', subpath => {
        const stem = subpath.slice('./'.length);
        expect(resolveSubpath(subpath, 'import')).toBe(`./dist/esm/${stem}`);
        expect(resolveSubpath(subpath, 'require')).toBe(`./dist/cjs/${stem}`);
    });

    test('explicit subpath keys still take precedence over patterns', () => {
        expect(resolveSubpath('./server', 'types')).toBe('./dist/esm/server/index.d.ts');
        expect(resolveSubpath('./validation/ajv', 'types')).toBe('./dist/esm/validation/ajv-provider.d.ts');
    });

    test('extensionless subpaths still resolve through the generic pattern', () => {
        expect(resolveSubpath('./server/mcp', 'import')).toBe('./dist/esm/server/mcp');
    });
});
