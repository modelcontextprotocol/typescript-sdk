import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '../../dist');
const NODE_ONLY = /\b(node:stream|node:child_process)\b/;

function chunkImportsOf(entryPath: string): string[] {
    const src = readFileSync(entryPath, 'utf8');
    return [...src.matchAll(/from\s+["']\.\/(.+?\.mjs)["']/g)].map(m => join(distDir, m[1]!));
}

describe('@modelcontextprotocol/server root entry is browser-safe', () => {
    test('dist/index.mjs contains no process-stdio runtime imports', () => {
        const entry = join(distDir, 'index.mjs');
        expect(readFileSync(entry, 'utf8')).not.toMatch(NODE_ONLY);
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
