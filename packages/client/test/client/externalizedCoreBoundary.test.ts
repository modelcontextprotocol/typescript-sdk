import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = join(pkgDir, 'dist');
const coreDir = join(pkgDir, '..', 'core');
const CORE_IMPORT = /\bfrom\s+["']@modelcontextprotocol\/core["']/;

function chunksImportingCore(): string[] {
    return (readdirSync(distDir, { recursive: true }) as string[])
        .filter(file => file.endsWith('.mjs'))
        .map(file => join(distDir, file))
        .filter(chunk => CORE_IMPORT.test(readFileSync(chunk, 'utf8')));
}

// Consumer side of the externalize-core-schemas boundary (see
// packages/core-internal/externalizeCoreSchemas.tsdown.mjs): the built package must resolve the
// schema modules from @modelcontextprotocol/core at runtime, and everything it imports from there
// must actually exist in core. The build-time assertions in the plugin guard the producer side;
// this test pins the consumer side of the published contract.
describe('@modelcontextprotocol/client dist resolves schemas from @modelcontextprotocol/core', () => {
    beforeAll(() => {
        if (!existsSync(join(distDir, 'index.mjs'))) {
            execFileSync('pnpm', ['build'], { cwd: pkgDir, stdio: 'inherit' });
        }
        if (!existsSync(join(coreDir, 'dist', 'index.mjs'))) {
            execFileSync('pnpm', ['build'], { cwd: coreDir, stdio: 'inherit' });
        }
    }, 240_000);

    test('built ESM chunks import the schemas from @modelcontextprotocol/core instead of inlining them', () => {
        expect(chunksImportingCore().length).toBeGreaterThan(0);
    });

    test('every name the built chunks import from @modelcontextprotocol/core exists in core, under real ESM linking', () => {
        for (const chunk of chunksImportingCore()) {
            // Plain-node import gives real ESM link semantics: it fails at instantiation if the chunk
            // names an export core does not provide (e.g. an SDK-internal helper schema accidentally
            // imported as a value) — exactly the error a published package would throw in consumers.
            // Vitest's own module transform would report such a name as `undefined` instead of failing.
            const result = spawnSync(
                process.execPath,
                ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(chunk).href)});`],
                { encoding: 'utf8', timeout: 30_000 }
            );
            expect(result.status, `importing ${chunk} failed:\n${result.error ?? result.stderr}`).toBe(0);
        }
    }, 60_000);
});
