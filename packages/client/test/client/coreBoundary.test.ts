/**
 * Schema-module boundary pins: the built client resolves its schemas from
 * @modelcontextprotocol/core instead of carrying its own copies.
 *
 * The client bundle keeps `@modelcontextprotocol/core/internal` as an external
 * runtime import (see tsdown.config.ts), so two things can silently go wrong:
 *
 * 1. Skew — the client dist imports a name that core's built entries no longer
 *    export (e.g. a schema added to core-internal's shims without adding it to
 *    core, or a rename that only landed on one side). That fails at consumer
 *    runtime, not at build time.
 * 2. Re-inlining — a config change (dropping the `external` entry, a paths
 *    alias resolving too early) makes the bundler inline the schema sources
 *    again, duplicating hundreds of Zod schemas into every sibling package.
 *
 * Both directions are asserted against the real build outputs. Only the ESM
 * chunks are parsed; the CJS build is produced from the same module graph, so
 * skew shows up identically in both.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

import { ensureBuilt } from '../helpers/ensureBuilt';

const clientPkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const clientDistDir = join(clientPkgDir, 'dist');
const corePkgDir = join(clientPkgDir, '..', 'core');
const coreDistDir = join(corePkgDir, 'dist');

/** Built core entry file per import specifier the client may use. */
const CORE_ENTRIES: Record<string, string> = {
    '@modelcontextprotocol/core': 'index.mjs',
    '@modelcontextprotocol/core/internal': 'internal.mjs'
};

/**
 * Sentinel schemas that exist ONLY in core's source modules. The frozen
 * wire-era modules (bundled into the client on purpose) define their own
 * copies of many spec schema names, but not these — so a `const` definition
 * of any of them inside the client dist can only mean the neutral schema
 * modules got re-inlined. The first two are names the client actually uses,
 * so they must also show up as imports; SafeUrlSchema is unused by the client
 * (legitimately tree-shaken away) and is pinned as never-defined only.
 */
const IMPORTED_SENTINELS = ['OAuthMetadataSchema', 'JSONRPCMessageSchema'];
const NEVER_DEFINED_SENTINELS = [...IMPORTED_SENTINELS, 'SafeUrlSchema'];

function clientChunks(): string[] {
    return readdirSync(clientDistDir).filter(f => f.endsWith('.mjs'));
}

/** Exported names of a built core entry (its trailing `export { a, b as c };` blocks). */
function coreExportedNames(entryFile: string): Set<string> {
    const src = readFileSync(join(coreDistDir, entryFile), 'utf8');
    const blocks = [...src.matchAll(/export \{([\s\S]*?)\}/g)];
    expect(blocks.length, `no export block found in core dist/${entryFile}`).toBeGreaterThan(0);
    const names = new Set<string>();
    for (const block of blocks) {
        for (const entry of block[1]!.split(',')) {
            const name = entry
                .trim()
                .split(/\s+as\s+/)
                .pop()
                ?.trim();
            if (name) {
                names.add(name);
            }
        }
    }
    return names;
}

/** All names a client chunk pulls from a core specifier, keyed by specifier. */
function coreImportsOf(chunkSource: string): Map<string, Set<string>> {
    const imports = new Map<string, Set<string>>();
    // import { A, B as C } from "@modelcontextprotocol/core[/internal]"
    // export { A, B as C } from "@modelcontextprotocol/core[/internal]"
    for (const m of chunkSource.matchAll(
        /(?:import|export)\s*\{([^}]*)\}\s*from\s*["'](@modelcontextprotocol\/core(?:\/internal)?)["']/g
    )) {
        const names = imports.get(m[2]!) ?? new Set<string>();
        for (const entry of m[1]!.split(',')) {
            // In both clause forms the name resolved against core is the one BEFORE `as`.
            const name = entry
                .trim()
                .split(/\s+as\s+/)[0]
                ?.trim();
            if (name) {
                names.add(name);
            }
        }
        imports.set(m[2]!, names);
    }
    return imports;
}

describe('@modelcontextprotocol/client ↔ core schema boundary', () => {
    beforeAll(async () => {
        await ensureBuilt(corePkgDir);
        await ensureBuilt(clientPkgDir);
    }, 240_000);

    test('every name the client dist imports from core resolves against core’s built exports', () => {
        let sawCoreImport = false;
        for (const chunk of clientChunks()) {
            const source = readFileSync(join(clientDistDir, chunk), 'utf8');
            for (const [specifier, names] of coreImportsOf(source)) {
                sawCoreImport = true;
                const entryFile = CORE_ENTRIES[specifier];
                expect(entryFile, `client dist/${chunk} imports unknown core subpath ${specifier}`).toBeDefined();
                const exported = coreExportedNames(entryFile!);
                const missing = [...names].filter(name => !exported.has(name));
                expect(
                    missing,
                    `client dist/${chunk} imports names from ${specifier} that core's built ${entryFile} does not export`
                ).toEqual([]);
            }
            // Non-named forms (namespace/default/bare imports, `export *`) would dodge the check above.
            expect(
                source,
                `client dist/${chunk} uses a non-named import/re-export of @modelcontextprotocol/core — update this test to cover it`
            ).not.toMatch(/(?:import|export)\s+(?!\{)[^;]*?from\s*["']@modelcontextprotocol\/core(?:\/internal)?["']/);
        }
        expect(sawCoreImport, 'no client chunk imports @modelcontextprotocol/core at all — external wiring changed?').toBe(true);
    });

    test('the neutral schema bodies stay OUT of the client dist (imported, never re-inlined)', () => {
        const sources = clientChunks().map(chunk => ({
            chunk,
            source: readFileSync(join(clientDistDir, chunk), 'utf8')
        }));

        const importedNames = new Set<string>();
        for (const { source } of sources) {
            for (const names of coreImportsOf(source).values()) {
                for (const name of names) {
                    importedNames.add(name);
                }
            }
        }

        for (const sentinel of IMPORTED_SENTINELS) {
            expect(importedNames.has(sentinel), `${sentinel} is not imported from core by any client chunk`).toBe(true);
        }

        for (const sentinel of NEVER_DEFINED_SENTINELS) {
            // `$N` suffix included: a re-inlined copy colliding with the import gets renamed by the
            // bundler. The `[=(]` tail covers both plain bindings and function-form definitions.
            const definition = new RegExp(`\\b(?:const|let|var|function)\\s+${sentinel}(?:\\$\\d+)?\\s*[=(]`);
            for (const { chunk, source } of sources) {
                expect(
                    source,
                    `client dist/${chunk} DEFINES ${sentinel} instead of importing it from @modelcontextprotocol/core — the neutral schema modules were re-inlined`
                ).not.toMatch(definition);
            }
        }
    });
});
