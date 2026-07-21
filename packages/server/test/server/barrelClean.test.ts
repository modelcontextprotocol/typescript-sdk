import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

import { ensureBuilt } from '../helpers/ensureBuilt';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = join(pkgDir, 'dist');
const requireDist = createRequire(join(pkgDir, 'package.json'));
const NODE_ONLY = /\b(child_process|cross-spawn|node:stream|node:child_process)\b/;
// Anchored at start-of-line so JSDoc-example `from 'ajv'` strings in vendored chunks don't match.
const VALIDATOR_BACKEND_IMPORT = /^import[^\n]*?from\s+["'](?:ajv|ajv-formats|@cfworker\/json-schema)["']/m;
const ROOT_VALIDATOR_EXPORTS = ['AjvJsonSchemaValidator', 'CfWorkerJsonSchemaValidator', 'CfWorkerSchemaDraft'];

function chunkImportsOf(entryPath: string): string[] {
    const visited = new Set<string>();
    const queue = [entryPath];
    while (queue.length > 0) {
        const file = queue.shift()!;
        if (visited.has(file)) continue;
        visited.add(file);
        const src = readFileSync(file, 'utf8');
        // Follow ./ and ../ relative chunk imports: subpath entries in nested
        // dist directories import shared chunks from parent directories.
        for (const m of src.matchAll(/from\s+["'](\.\.?\/.+?\.mjs)["']/g)) {
            queue.push(join(dirname(file), m[1]!));
        }
    }
    visited.delete(entryPath);
    return [...visited];
}

function rootExportBlockOf(content: string): string {
    const blocks = content.match(/(?:^|\n)export \{[\s\S]*?\};/g);
    expect(blocks).toBeTruthy();
    return blocks!.at(-1)!;
}

describe('@modelcontextprotocol/server root entry is browser-safe', () => {
    beforeAll(async () => {
        // Single-flight across parallel vitest workers: this file and
        // workerdSchemaPreload.test.ts both read the built dist, and two
        // unlocked `pnpm build`s would race tsdown's clean step.
        await ensureBuilt(pkgDir);
    }, 180_000);

    test('dist/index.mjs does not export StdioServerTransport and has no process-stdio runtime imports', () => {
        const entry = readFileSync(join(distDir, 'index.mjs'), 'utf8');
        // Server stdio has only type-level node:stream imports (erased at compile time), so the
        // meaningful regression check is that the symbol itself is absent from the root barrel.
        expect(entry).not.toMatch(/\bexport\s*\{[^}]*\bStdioServerTransport\b/);
        expect(entry).not.toMatch(NODE_ONLY);
    });

    test('chunks transitively imported by dist/index.mjs contain no process-stdio runtime imports', () => {
        const entry = join(distDir, 'index.mjs');
        for (const chunk of chunkImportsOf(entry)) {
            expect({ chunk, content: readFileSync(chunk, 'utf8') }).not.toEqual(
                expect.objectContaining({ content: expect.stringMatching(NODE_ONLY) })
            );
        }
    });

    test('dist/stdio.mjs exists and exports StdioServerTransport', () => {
        const stdio = readFileSync(join(distDir, 'stdio.mjs'), 'utf8');
        expect(stdio).toMatch(/\bStdioServerTransport\b/);
    });

    test('runtime shims vendor default validator backends instead of requiring consumers to install them', () => {
        for (const shim of ['shimsNode.mjs', 'shimsWorkerd.mjs', 'shimsBrowser.mjs']) {
            const entry = join(distDir, shim);
            expect(readFileSync(entry, 'utf8')).not.toMatch(VALIDATOR_BACKEND_IMPORT);

            for (const chunk of chunkImportsOf(entry)) {
                expect({ chunk, content: readFileSync(chunk, 'utf8') }).not.toEqual(
                    expect.objectContaining({ content: expect.stringMatching(VALIDATOR_BACKEND_IMPORT) })
                );
            }
        }
    });

    test('CJS AJV validator subpath exposes Ajv at runtime', () => {
        const { Ajv, AjvJsonSchemaValidator, addFormats } = requireDist(
            './dist/validators/ajv.cjs'
        ) as typeof import('../../src/validators/ajv');

        const ajv = new Ajv({ strict: false, allErrors: true });
        addFormats(ajv);

        expect(new AjvJsonSchemaValidator(ajv)).toBeInstanceOf(AjvJsonSchemaValidator);
    });

    test('root declarations do not advertise validator provider classes', () => {
        for (const declaration of ['index.d.mts', 'index.d.cts']) {
            const rootExportBlock = rootExportBlockOf(readFileSync(join(distDir, declaration), 'utf8'));
            for (const symbol of ROOT_VALIDATOR_EXPORTS) {
                expect(rootExportBlock).not.toMatch(new RegExp(`\\b(?:type\\s+)?${symbol}\\b`));
            }
        }
    });
});

describe('@modelcontextprotocol/server experimental server-card subpath', () => {
    beforeAll(async () => {
        await ensureBuilt(pkgDir);
    }, 180_000);

    test('dist/experimental/serverCard.mjs exists, exports the responders, and stays runtime-neutral', () => {
        const entry = join(distDir, 'experimental/serverCard.mjs');
        const content = readFileSync(entry, 'utf8');
        expect(content).toMatch(/\bserverCardResponse\b/);
        expect(content).toMatch(/\baiCatalogResponse\b/);
        expect(content).toMatch(/\bbuildServerCard\b/);
        expect(content).not.toMatch(NODE_ONLY);
        for (const chunk of chunkImportsOf(entry)) {
            expect({ chunk, content: readFileSync(chunk, 'utf8') }).not.toEqual(
                expect.objectContaining({ content: expect.stringMatching(NODE_ONLY) })
            );
        }
    });

    test('root declarations do not advertise the experimental server-card exports', () => {
        for (const declaration of ['index.d.mts', 'index.d.cts']) {
            const rootExportBlock = rootExportBlockOf(readFileSync(join(distDir, declaration), 'utf8'));
            for (const symbol of ['serverCardResponse', 'aiCatalogResponse', 'buildServerCard', 'buildAICatalog']) {
                expect(rootExportBlock).not.toMatch(new RegExp(`\\b(?:type\\s+)?${symbol}\\b`));
            }
        }
    });
});
