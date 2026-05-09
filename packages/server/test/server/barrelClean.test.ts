import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = join(pkgDir, 'dist');
const NODE_ONLY = /\b(child_process|cross-spawn|node:stream|node:child_process)\b/;

function chunkImportsOf(entryPath: string): string[] {
    const visited = new Set<string>();
    const queue = [entryPath];
    while (queue.length > 0) {
        const file = queue.shift()!;
        if (visited.has(file)) continue;
        visited.add(file);
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/from\s+["']\.\/(.+?\.mjs)["']/g)) {
            queue.push(join(dirname(file), m[1]!));
        }
    }
    visited.delete(entryPath);
    return [...visited];
}

describe('@modelcontextprotocol/server root entry is browser-safe', () => {
    beforeAll(() => {
        if (!existsSync(join(distDir, 'index.mjs')) || !existsSync(join(distDir, 'stdio.mjs'))) {
            execFileSync('pnpm', ['build'], { cwd: pkgDir, stdio: 'inherit' });
        }
    }, 60_000);

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
});
